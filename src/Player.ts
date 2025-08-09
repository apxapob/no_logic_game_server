import WebSocket, { RawData } from "ws"
import { generateUID } from "./Utils"
import { Server } from "./Server";

const generatePassword = () => 'xxxxxxxxxxxxxxxx'.replace(/x/g,
  c => (Math.random() * 36 | 0).toString(36)
)

export type WSMessage = {
  method: string;
  data?: number | string | object;
}

export class Player {
  public playerId:string = ''
  public playerName:string = ''
  public password:string = ''
  public ws:WebSocket|null
  public roomId:string|null = null
  public rtt:number|null = null
  public roomEntryTimestamp:number|null = null

  constructor(name:string, playerId:string|null, password:string|null, ws:WebSocket){
    this.playerName = name
    this.ws = ws
    this.playerId = playerId || generateUID()
    this.password = password || generatePassword()
    this.rtt = null
    this.roomEntryTimestamp = null
  }

  send(msg:WSMessage){
    if(Server.instance.DevMode){
      console.log("Send", msg, "to", this.playerName + " (" + this.playerId + ")")
    }
    this.ws?.send( JSON.stringify(msg) )
  }

  sendString(msg:String){
    if(Server.instance.DevMode){
      console.log("Send", msg, "to", this.playerName + " (" + this.playerId + ")")
    }
    this.ws?.send(msg)
  }

  sendBinary(bytes:RawData){
    this.ws?.send(bytes)
  }

  toNetObject() {
    return {
      playerId: this.playerId,
      name: this.playerName,
      rtt: this.rtt,
      roomEntryTimestamp: this.roomEntryTimestamp
    }
  }
}