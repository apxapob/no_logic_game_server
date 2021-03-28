
export class Room {
  public roomId:string = '';
  public playerIds:Array<string> = [];

  constructor(id:string){
    this.roomId = id
  }
}