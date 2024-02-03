import { Server } from "./Server"

console.clear()

process.on('uncaughtException', err => {
  console.error('Caught exception: ' + err);
});

let serverInstance = new Server()
console.log("server started")