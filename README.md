# No Logic Game Server

Simple server for games with logic on client.

## Installation

Download source or clone this repository.
Install all the dependencies:

```bash
// with npm
npm install

// with yarn
yarn install
```

Run the server:

```bash
// with npm
npm run start

// with yarn
yarn run start
```

Open `demo.html` in 2 browser tabs. If game starts then everything is ok.

## API

Server sends and receives JSON strings of this format:

```js
{
  method: "methodName",
  data: {...method parameters}
}
```

## Connect to Server

First time client must connect without credentials.
Like this:

```
ws://localhost:8080/
```

Server will create a new account and send its data to client.
After this client can connect with credentials like this:

```
ws://localhost:8080/?name=$myPlayerName&playerId=$myId&password=$myPassword
```

## Server Commands

#### Room Management

- **getRooms**: Get list of open rooms. No data required.

- **createRoom**: Create a new room.
  - Data:
    ```js
    {
      name: "room name",
      maxPlayers: number,
      password: string or null,
      gameData: object or null
    }
    ```

- **enterRoom**: Enter a selected room.
  - Data:
    ```js
    {
      roomId: "roomId",
      password: "room password"
    }
    ```

- **leaveRoom**: Leave the current room. No data required.

#### Player Management

- **changeName**: Change player name.
  - Data: `new name string`

- **getPlayers**: Get selected players' data.
  - Data: array of player IDs (or null for all players)


#### Gameplay Commands

- **sendChatMsg**: Send a chat message to the current room.
  - Data: any string

- **startGame**: Start the game (only by room owner).
  - Data: any object with initial game state

- **shareGameState**: Share full game state with other players (only by room owner).
  - Data:
    ```js
    {
      gamestate: any object,
      to: list of player IDs (optional)
    }
    ```

- **sendToRoom**: Send any data to other players in the room.
  - Data: any object

- **sendTo**: Send any data to selected players in the room.
  - Data:
    ```js
    {
      to: [...playerIds],
      msg: {...any object}
    }
    ```

#### Room Metadata

- **setRoomMeta**: Set metadata for the current room (only by room owner).
  - Data: any object with metadata

#### Networking

- **Pong**: Respond to server ping with timestamp.
  - Data: server timestamp in milliseconds (received from Ping message)

## Server responses

#### Connection & Authentication

- **onConnected**: Sent after successful connection.
  - Data:
    ```js
    {
      online: number of currently connected players
    }
    ```

- **accountCreated**: When someone connects without credentials.
  - Data:
    ```js
    {
      name: playerName,
      playerId: playerId,
      password: password
    }
    ```

#### Room Management

- **roomCreated**: Sent when a room is created.
  - Data: object with created room information

- **roomDeleted**: Sent when a room is deleted.
  - Data: `roomId`

- **roomBlock**: Sent when game starts and no more players can enter the room.
  - Data: `roomId`

- **onGetRooms**: List of available rooms.
  - Data: array with available rooms information

- **onRoomEnter**: Sent when successfully entered a room.
  - Data: room info

#### Player Management

- **onGetPlayers**: List of players.
  - Data: array of players

- **playerEnter**: Sent when another player enters the current room.
  - Data: new player info

- **playerLeft**: Sent when someone leaves the current room.
  - Data: `playerId`

- **nameChanged**: Sent when someone changes their name.
  - Data:
    ```js
    {
      name: new name,
      playerId: playerId
    }
    ```

#### Gameplay Messages

- **newGameState**: Sent when room owner shares game state.
  - Data: any object

- **messageFromPlayer**: Sent when someone sends you game data.
  - Data:
    ```js
    {
      from: playerId,
      msg: any object
    }
    ```

- **chatMsg**: Chat message received.
  - Data:
    ```js
    {
      text: any string,
      from: playerId
    }
    ```

#### Game State

- **gameStarted**: Sent when game starts. No data.

#### Networking & Errors

- **playerDisconnected**: Sent when a player disconnects.
  - Data: `playerId`

- **newRoomOwner**: Sent when owner leaves room and server appoints a new owner.
  - Data: `ownerId`

- **RoomRTT**: Round-trip time values for all players in the room.
  - Data: dictionary with RTT values

- **Ping**: Server sends Ping message to all clients every 10 seconds to check connection status.
  - Data: server timestamp in milliseconds. You need to respond to this message with a Pong message and send back the same timestamp for correct RTT (Round Trip Time) measurement.

- **error**: Sent when an error occurs.
  - Data:
    ```js
    {
      text: error message,
      code: error code
    }
    ```

- **gameStateRequested**: Sent to room owner when a player requests the game state.
  - Data: player object

- **onSetRoomMeta**: Sent when room metadata is set by the owner.
  - Data: object with room metadata

- **wrongPassword**: Sent when wrong password is provided during connection.
