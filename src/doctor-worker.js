import { parentPort, workerData } from "node:worker_threads";
import { doctor } from "./doctor.js";

const agent = workerData.agent;
parentPort.postMessage(doctor(agent)[agent]);
