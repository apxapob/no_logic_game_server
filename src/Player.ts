import WebSocket from "ws"

const generateUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

export class Player {
  public playerId:string = ''
  public playerName:string = ''
  public ws:WebSocket

  constructor(name:string, ws:WebSocket){
    this.playerName = name
    this.ws = ws
    this.playerId = generateUID()
  }
}