import WebSocket, { RawData } from "ws"
import { generateUID } from "./Utils"

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

  constructor(name:string, playerId:string|null, password:string|null, ws:WebSocket){
    this.playerName = name
    this.ws = ws
    this.playerId = playerId || generateUID()
    this.password = password || generatePassword()
    this.rtt = null
  }

  send(msg:WSMessage){
    this.ws?.send( JSON.stringify(msg) )
  }
  sendString(msg:String){
    this.ws?.send(msg)
  }
  sendBinary(bytes:RawData){
    this.ws?.send(bytes)
  }

  toNetObject() {
    return {
      playerId: this.playerId,
      name: this.playerName,
      rtt: this.rtt
    }
  }
}