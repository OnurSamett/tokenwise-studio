using System.IO;
using System.Net.Http;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TokenwiseStudio;

internal static class Program
{
    internal const string RuntimeUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        using var mutex = new Mutex(true, "Local\\TokenwiseStudio.Windows", out var first);
        if (!first)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", "TokenwiseStudio.Windows", PipeDirection.Out);
                pipe.Connect(3000);
                using var writer = new StreamWriter(pipe);
                writer.WriteLine(JsonSerializer.Serialize(args));
            }
            catch { MessageBox.Show("The studio is starting. Please try opening it again shortly.", "tokenwise studio"); }
            return;
        }
        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (WebView2RuntimeNotFoundException)
        {
            if (MessageBox.Show("Microsoft Edge WebView2 Runtime is missing. Open the Microsoft Evergreen installer download? After installing it, open tokenwise studio again.", "tokenwise studio", MessageBoxButtons.YesNo) == DialogResult.Yes)
                External(RuntimeUrl);
            return;
        }
        Directory.CreateDirectory(StudioContext.StateDir);
        Application.Run(new StudioContext(args));
    }
    internal static void External(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https" or "mailto")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception e) { MessageBox.Show(e.Message, "Could not open browser"); }
    }
}

internal sealed class StudioContext : ApplicationContext
{
    internal static readonly string StateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tokenwise-studio");
    readonly Dictionary<string, Form> windows = new(StringComparer.OrdinalIgnoreCase);
    readonly Control dispatcher = new();
    readonly CancellationTokenSource lifetime = new();
    Form? welcome;
    internal StudioContext(string[] args)
    {
        _ = dispatcher.Handle;
        _ = Listen();
        var projects = args.Length > 0 ? args : ReadSaved();
        foreach (var repo in projects.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase)) Open(repo);
        if (windows.Count == 0) Welcome();
    }
    static string[] ReadSaved()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(StateDir, "windows-state.json")));
            return doc.RootElement.Deserialize<string[]>() ?? [];
        }
        catch { return []; }
    }
    void Save()
    {
        try
        {
            var file = Path.Combine(StateDir, "windows-state.json");
            File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(windows.Keys.ToArray()));
            File.Move(file + ".tmp", file, true);
        }
        catch { }
    }
    async Task Listen()
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream("TokenwiseStudio.Windows", PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(lifetime.Token).ConfigureAwait(false);
                using var reader = new StreamReader(pipe);
                var line = await reader.ReadLineAsync(lifetime.Token).ConfigureAwait(false);
                var args = JsonSerializer.Deserialize<string[]>(line ?? "[]") ?? [];
                dispatcher.BeginInvoke((Action)(() => { if (args.Length == 0) Welcome(); else foreach (var repo in args) Open(repo); }));
            }
            catch (OperationCanceledException) { break; }
            catch { break; }
        }
    }
    internal void Browse()
    {
        using var picker = new FolderBrowserDialog { Description = "Open a project in tokenwise studio", UseDescriptionForTitle = true };
        if (picker.ShowDialog() == DialogResult.OK) Open(picker.SelectedPath);
    }
    internal void Open(string raw)
    {
        try
        {
            var repo = Path.TrimEndingDirectorySeparator(Path.GetFullPath(raw));
            if (!Directory.Exists(repo)) throw new IOException("Project folder does not exist: " + repo);
            if (windows.TryGetValue(repo, out var existing)) { existing.WindowState = FormWindowState.Normal; existing.Activate(); return; }
            var form = new ProjectForm(repo, this);
            windows.Add(repo, form);
            form.FormClosing += (_, _) => Save();
            form.FormClosed += (_, _) =>
            {
                windows.Remove(repo);
                if (windows.Count > 0) Save(); // Keep the last project for the next launch.
                if (windows.Count == 0 && welcome == null) ExitThread();
            };
            form.Show();
            Save();
            welcome?.Close();
        }
        catch (Exception e) { MessageBox.Show(e.Message, "Could not open project"); }
    }
    void Welcome()
    {
        if (welcome != null) { welcome.Activate(); return; }
        welcome = new Form { Text = "tokenwise studio", Width = 620, Height = 430, StartPosition = FormStartPosition.CenterScreen };
        ProjectForm.SetIcon(welcome);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(24) };
        layout.Controls.Add(new Label { Text = "Welcome to tokenwise studio", AutoSize = true, Font = new Font(SystemFonts.DefaultFont.FontFamily, 18) });
        var open = new Button { Text = "Open folder…", AutoSize = true, Margin = new Padding(0, 20, 0, 20) };
        open.Click += (_, _) => Browse();
        layout.Controls.Add(open);
        try
        {
            var recents = JsonSerializer.Deserialize<string[]>(File.ReadAllText(Path.Combine(StateDir, "recents.json"))) ?? [];
            foreach (var repo in recents.Where(Directory.Exists).Take(8))
            {
                var button = new Button { Text = repo, AutoSize = true };
                button.Click += (_, _) => Open(repo);
                layout.Controls.Add(button);
            }
        }
        catch { }
        welcome.Controls.Add(layout);
        welcome.FormClosed += (_, _) => { welcome = null; if (windows.Count == 0) ExitThread(); };
        welcome.Show();
    }
    protected override void ExitThreadCore()
    {
        lifetime.Cancel();
        dispatcher.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class ProjectForm : Form
{
    readonly string repo;
    readonly StudioContext context;
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    Uri? origin;
    bool loading;
    internal ProjectForm(string repo, StudioContext context)
    {
        this.repo = repo; this.context = context;
        Text = "tokenwise studio — " + Path.GetFileName(repo);
        Width = 1280; Height = 860; MinimumSize = new Size(900, 600);
        SetIcon(this);
        var menu = new MenuStrip();
        var file = new ToolStripMenuItem("File");
        file.DropDownItems.Add("Open folder…", null, (_, _) => context.Browse());
        menu.Items.Add(file);
        Controls.Add(web); Controls.Add(menu); MainMenuStrip = menu;
        Shown += async (_, _) => await LoadStudio();
    }
    internal static void SetIcon(Form form)
    {
        var file = Path.Combine(AppContext.BaseDirectory, "app.ico");
        if (File.Exists(file)) form.Icon = new Icon(file);
    }
    bool Local(string url) => origin != null && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == origin.Scheme && uri.Host == origin.Host && uri.Port == origin.Port;
    async Task LoadStudio()
    {
        if (loading || IsDisposed) return;
        loading = true;
        try
        {
            origin = await StudioServer.Ensure(repo);
            if (IsDisposed) return;
            if (web.CoreWebView2 == null)
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(StudioContext.StateDir, "webview2"));
                await web.EnsureCoreWebView2Async(env);
                await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.__tokenwiseWindows = true;");
                web.CoreWebView2.NavigationStarting += (_, e) => { if (!Local(e.Uri)) { e.Cancel = true; Program.External(e.Uri); } };
                web.CoreWebView2.FrameNavigationStarting += (_, e) => { if (!Local(e.Uri)) e.Cancel = true; };
                web.CoreWebView2.NewWindowRequested += (_, e) => { e.Handled = true; if (Local(e.Uri)) web.CoreWebView2.Navigate(e.Uri); else Program.External(e.Uri); };
                web.CoreWebView2.WebMessageReceived += (_, e) =>
                {
                    if (!Local(e.Source)) return;
                    try
                    {
                        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                        var root = doc.RootElement;
                        switch (root.GetProperty("type").GetString())
                        {
                            case "browse": context.Browse(); break;
                            case "project": context.Open(root.GetProperty("path").GetString()!); break;
                        }
                    }
                    catch { }
                };
                web.CoreWebView2.PermissionRequested += (_, e) =>
                {
                    if (!Local(e.Uri)) e.State = CoreWebView2PermissionState.Deny;
                    // Local notification requests use WebView2's permission prompt.
                };
                web.CoreWebView2.NavigationCompleted += async (_, e) => { if (!e.IsSuccess && !loading && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) await LoadStudio(); };
            }
            web.CoreWebView2.Navigate(origin.AbsoluteUri);
        }
        catch (Exception e)
        {
            StudioServer.Log(e.ToString());
            if (!IsDisposed && MessageBox.Show(this, e.Message + "\n\nCheck ~/.tokenwise-studio/windows-launcher.log. Retry?", "Could not start studio", MessageBoxButtons.RetryCancel) == DialogResult.Retry)
            { loading = false; await LoadStudio(); }
        }
        finally { loading = false; }
    }
}

internal static class StudioServer
{
    static readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
    // Serializing starts prevents registry read/write races when restoring multiple projects.
    static readonly SemaphoreSlim starts = new(1);
    static readonly string AppDir = Path.Combine(AppContext.BaseDirectory, "app");
    static string Version
    {
        get
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppDir, "package.json")));
            return doc.RootElement.GetProperty("version").GetString()!;
        }
    }
    internal static void Log(string message)
    {
        try { File.AppendAllText(Path.Combine(StudioContext.StateDir, "windows-launcher.log"), DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine); }
        catch { }
    }
    static Uri? Registered(string repo)
    {
        try
        {
            var map = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(StudioContext.StateDir, "servers.json")));
            var value = map?.FirstOrDefault(x => string.Equals(Path.GetFullPath(x.Key), repo, StringComparison.OrdinalIgnoreCase)).Value;
            if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == "http" && uri.IsLoopback && uri.AbsolutePath == "/" && uri.UserInfo == "" && uri.Query == "" && uri.Fragment == "") return uri;
        }
        catch { }
        return null;
    }
    static async Task<string?> Health(Uri uri, string repo)
    {
        try
        {
            using var response = await http.GetAsync(new Uri(uri, "api/state"));
            response.EnsureSuccessStatusCode();
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (!string.Equals(Path.GetFullPath(doc.RootElement.GetProperty("repo").GetString()!), repo, StringComparison.OrdinalIgnoreCase)) return null;
            return doc.RootElement.TryGetProperty("version", out var version) ? version.GetString() ?? "" : "";
        }
        catch { return null; }
    }
    internal static async Task<Uri> Ensure(string repo)
    {
        await starts.WaitAsync();
        try
        {
            var version = Version;
            var old = Registered(repo);
            if (old != null)
            {
                var running = await Health(old, repo);
                if (running == version) return old;
                if (running != null)
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(old, "api/quit"));
                    request.Headers.Add("x-tokenwise", "1");
                    request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
                    using var response = await http.SendAsync(request);
                    if (!response.IsSuccessStatusCode) throw new IOException("An older studio server is busy or cannot quit. Finish its work and reopen this project.");
                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (await Health(old, repo) != null)
                    {
                        if (DateTime.UtcNow >= deadline) throw new IOException("The older studio server did not stop. Close it and retry.");
                        await Task.Delay(200);
                    }
                }
            }
            var node = Path.Combine(AppContext.BaseDirectory, "node", "node.exe");
            var info = new ProcessStartInfo(node) { WorkingDirectory = repo, UseShellExecute = false, CreateNoWindow = true };
            info.ArgumentList.Add(Path.Combine(AppDir, "src", "cli.js"));
            info.ArgumentList.Add(repo); info.ArgumentList.Add("--no-open");
            info.Environment["PATH"] = Path.GetDirectoryName(node) + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH");
            // No redirected pipes: their closure on app exit must not break the persistent server.
            using var child = Process.Start(info) ?? throw new IOException("Could not start embedded Node.js.");
            Log($"Started server pid={child.Id} project={repo}");
            for (var i = 0; i < 75; i++)
            {
                await Task.Delay(400);
                var uri = Registered(repo);
                if (uri != null && await Health(uri, repo) == version) return uri;
                if (child.HasExited) throw new IOException("Studio server exited with code " + child.ExitCode);
            }
            throw new TimeoutException("Studio server did not start within 30 seconds.");
        }
        finally { starts.Release(); }
    }
}
