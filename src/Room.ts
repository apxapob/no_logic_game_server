import { Server } from "./Server"
import { Player, WSMessage } from "./Player"
import { generateUID } from "./Utils"
import { RawData } from "ws"

export class Room {
  public roomId:string = ''
  public ownerId:string|null = ''
  public roomName:string = ''
  public password:string|null = null
  public gameData:string|object|null = null
  public maxPlayers = 6
  public playerIds:Array<string> = []
  public gameStarted:boolean = false
  public RTTintervalId:NodeJS.Timeout|null = null

  constructor(name:string, ownerId:string, maxPlayers = -1, password?:string, gameData:string|object|null = null){
    this.roomId = generateUID()
    this.ownerId = ownerId
    this.roomName = name || 'Room'
    this.password = password ?? null
    this.gameData = gameData
    if(maxPlayers > 0){
      this.maxPlayers = maxPlayers
    }
  }

  toNetObject() {
    return {
      roomId: this.roomId,
      ownerId: this.ownerId,
      name: this.roomName,
      players: this.playerIds,
      maxPlayers: this.maxPlayers,
      gameData: this.gameData,
      gameStarted: this.gameStarted
    }
  }

  sendToRoom(msg:WSMessage){
    const json = JSON.stringify(msg)
    this.playerIds.forEach(
      plId => Server.instance.players[plId]?.sendString(json)
    )
  }

  sendToOthers(msg:WSMessage, fromId:string){
    const json = JSON.stringify(msg)
    this.playerIds.forEach(plId => {
      if(plId === fromId) return
      Server.instance.players[plId]?.sendString(json)
    })
  }

  sendBinaryToOthers(bytes:RawData, fromId:string){
    this.playerIds.forEach(plId => {
      if(plId === fromId) return
      Server.instance.players[plId]?.sendBinary(bytes)
    })
  }

  playerDisconnected(pl:Player){
    this.sendToRoom({ method: 'playerDisconnected', data: pl.playerId })
    pl.roomId = null
    if(pl.playerId !== this.ownerId){ return }
    
    this.ownerId = this.playerIds.find(
      playerId => playerId !== pl.playerId && Server.instance.players[playerId]?.roomId === this.roomId
    ) ?? null
    if(this.ownerId === null){
      this.dispose()
    } else {
      this.sendToRoom({
        method: 'newRoomOwner',
        data: this.ownerId
      })
    }
  }

  removePlayer(pl:Player){
    pl.roomId = null
    const playerIdx = this.playerIds.indexOf(pl.playerId)
    if(playerIdx === -1){ return }

    this.playerIds.splice(playerIdx, 1)
    this.sendToRoom({
      method: 'playerLeft',
      data: pl.playerId
    })

    if(this.playerIds.length === 0){
      this.dispose()
      return
    }

    if(this.ownerId !== pl.playerId){ return }
    
    this.ownerId = this.playerIds[0]
    this.sendToRoom({
      method: 'newRoomOwner',
      data: this.ownerId
    })
  }

  reconnectPlayer(pl:Player){
    if(!this.gameStarted){
      return
    }
    if(!this.playerIds.includes(pl.playerId)){
      pl.send({
        method: 'error',
        data: { text: 'Game in this room started without you', code: "game_started_without_you" }
      })
      return
    }

    this.sendToRoom({
      method: 'playerEnter',
      data: pl.toNetObject()
    })
    
    pl.roomId = this.roomId
    pl.send({
      method: 'onRoomEnter',
      data: this.toNetObject()
    })
  }

  addPlayer(pl:Player, password:string|null){
    if(this.playerIds.includes(pl.playerId)){
      pl.send({
        method: 'error',
        data: { text: 'Already in this room', code: "already_in_room" }
      })
      return
    }
    if(pl.roomId && pl.roomId !== this.roomId){
      pl.send({
        method: 'error',
        data: { text: 'Leave other room first', code: "in_other_room" }
      })
      return
    }
    if(this.gameStarted){
      pl.send({
        method: 'error',
        data: { text: 'Game in this room already started', code: "game_in_room_started" }
      })
      return
    }
    if(this.playerIds.length >= this.maxPlayers){
      pl.send({
        method: 'error',
        data: { text: 'This room is full', code: "full_room" }
      })
      return
    }
    
    if(password !== this.password){
      pl.send({
        method: 'error',
        data: { text: 'Wrong room password', code: "wrong_password" }
      })
      return
    }

    this.sendToRoom({
      method: 'playerEnter',
      data: pl.toNetObject()
    })
    
    this.playerIds.push(pl.playerId)
    pl.roomId = this.roomId
    pl.send({
      method: 'onRoomEnter',
      data: this.toNetObject()
    })
  }

  broadcastRTT() {
    if (!this.gameStarted) return

    const rttData: Record<string, number> = {}
    this.playerIds.forEach(playerId => {
      const player = Server.instance.players[playerId]
      if (player?.rtt !== null) {
        rttData[playerId] = player.rtt
      }
    })

    this.sendToRoom({
      method: 'RoomRTT',
      data: rttData
    })
  }

  startGame(starter:Player, data:any){
    if(starter.playerId != this.ownerId){
      starter.send({
        method: 'error',
        data: { text: 'You can\'t start game in this room', code: "not_room_owner" }
      })
      return
    }
    if(this.gameStarted){
      starter.send({
        method: 'error',
        data: { text: 'The game already started', code: "already_started" }
      })
      return
    }
    this.gameStarted = true
    this.sendToRoom({ method: 'gameStarted', data })

    this.RTTintervalId = setInterval(() => {
      if (this.gameStarted) {
        this.broadcastRTT()
      }
    }, 10000)
  }

  dispose(){
    this.RTTintervalId && clearInterval(this.RTTintervalId)
    delete Server.instance.rooms[this.roomId]
  }
}