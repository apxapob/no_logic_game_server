import { Server } from "./Server"

console.clear()

export const logMessage = (message?: any, ...optionalParams: any[]) => {
  console.log(
    `[${new Date().toLocaleString()}]`, 
    message, ...optionalParams
  )
}

new Server()

const exitHandler = (...args:any) => {
  Server.instance?.stop(args)
}

process.on('uncaughtException', (e) => logMessage("Uncaught Exception", e))

process.on('exit', exitHandler)
process.on('SIGINT', exitHandler)
process.on('SIGUSR1', exitHandler)
process.on('SIGUSR2', exitHandler)