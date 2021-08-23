import { Server } from "./Server"

console.clear()

process.on('uncaughtException', err => {
  console.error('Caught exception: ' + err);
});

let serverInstance = new Server()
console.log("server started")

///////////////////////////
const statik = require('node-static');

//
// Create a node-static server instance to serve the './html' folder
//
const file = new statik.Server(__dirname + '\\html', { cache: 60 });

require('http').createServer(
  (request:any, response:any) => {
    request.addListener('end', () => {
      // Serve files!
      file.serve(request, response);
    }).resume();
  }
).listen(8079);