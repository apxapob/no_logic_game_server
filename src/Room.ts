
export class Room {
  public roomId:string = '';
  public ownerId:string = '';
  public roomName:string = '';
  public playerIds:Array<string> = [];

  constructor(name:string, ownerId:string){
    this.roomId = Date.now().toString()
    this.ownerId = ownerId
    this.roomName = name
  }

  toNetObject() {
    return {
      id: this.roomId,
      ownerId: this.ownerId,
      name: this.roomName,
      players: this.playerIds
    }
  }
}