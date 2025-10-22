import { Server } from "./Server"

console.clear()

const DevMode = process.argv.includes("dev")
const SendDelay = Number(process.argv.find(arg => arg.startsWith('delay='))?.substring(6) ?? 0)

export const logMessage = (message?: any, ...optionalParams: any[]) => {
  console.log(
    `[${new Date().toLocaleTimeString()}]`, 
    message, ...optionalParams
  )
}

new Server(DevMode, SendDelay)

const exitHandler = (...args:any) => {
  Server.instance?.stop(args)
}

process.on('uncaughtException', (e) => logMessage("Uncaught Exception", e))

process.on('exit', exitHandler)
process.on('SIGINT', exitHandler)
process.on('SIGUSR1', exitHandler)
process.on('SIGUSR2', exitHandler)