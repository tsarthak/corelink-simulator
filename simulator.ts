// Simulation parameters
const RELAY_MAX_CONNECTIONS = 8;
const MAX_CLIENTS = 30;
const CLIENT_CHANGE_RATE = 400;
const CLIENT_ADD_PROBA = 0.2;
const CLIENT_REMOVE_PROBA = 0.1;

// Timing stuff
let currentTime = 0.0;
const events: Array<[number, () => void]> = [];
let eventTimer: number | undefined;

function schedule() {
  events.sort((a, b) => a[0] - b[0]);
  if(eventTimer !== undefined) {
    clearTimeout(eventTimer);
    eventTimer = undefined;
  }
  if(events.length > 0) {
    const nextEvent = events[0];
    eventTimer = setTimeout(
      () => {
        currentTime = nextEvent[0];
        nextEvent[1]();
        events.splice(0, 1);
        schedule();
      },
      Math.max(0, nextEvent[0] - currentTime),
    );
  }
}

function sleep(duration: number): Promise<void> {
  const targetTime = currentTime + duration;
  return new Promise((resolve, reject) => {
    events.push([targetTime, resolve]);
    schedule();
  });
}

function addTimeout(func: () => void, duration: number) {
  const targetTime = currentTime + duration;
  events.push([targetTime, func]);
  schedule();
}

// Simulation stuff
let control: Control;

interface Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};
  running: boolean;

  latency(): number;
  getStream(streamId: number): Promise<void>;
}

async function rpc(source: Peer, target: Peer, method: string, ...args: any[]) {
  // Measure latency between source and target
  const dx = source.position[0] - target.position[0];
  const dy = source.position[1] - target.position[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const latency = dist + source.latency() + target.latency();

  // Wait to simulate travel time of packet
  await sleep(latency * 20);

  // Call target function
  const result = await (target as unknown as any)[method](...args);

  // Wait to simulate travel time back
  await sleep(latency * 20);

  // Return
  return result;
}

interface Connection {
  id: number;
  source: Peer;
  target: Peer;
  streamId: number;
}

const connections: {[id: string]: Connection} = {};
let nextConnectionId = 0;

async function addStreamConnection(source: Peer, target: Peer, streamId: number) {
  const id = nextConnectionId++;
  await source.getStream(streamId);
  if(source.running && target.running) {
    const connection = {id, source, target, streamId};
    connections[id] = connection;
    source.connections[id] = connection;
    target.connections[id] = connection;
    console.log("Connection established: " + source.name + " -> " + target.name + " (" + streamId + ")");
    draw();
  }
}

class Client implements Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};
  running: boolean;
  failed: boolean;

  publishedStream?: number;

  constructor(name: string, position: [number, number]) {
    this.name = name;
    this.position = position;
    this.running = true;
    this.failed = false;

    this.connections = {};
  }

  latency(): number {
    return 20;
  }

  async getStream(streamId: number): Promise<void> {
    if(streamId !== this.publishedStream) {
      throw new Error(this.name + " can't get stream " + streamId);
    }
  }

  async findHomeRelay(): Promise<Relay | null> {
    // Get the list of relays from control
    const availableRelays = await control.listRelays();

    if(availableRelays.length === 0) {
      console.error(this.name + " got no relays to ping");
      return null;
    }

    // Ping them
    const pingPromises = [];
    for(const relay of availableRelays) {
      pingPromises.push(this.ping(relay));
    }
    const pings = await Promise.all(pingPromises);

    // Pick the lowest ping
    pings.sort((a, b) => a[1] - b[1]);
    return pings[0][0];
  }

  async ping(relay: Relay): Promise<[Relay, number]> {
    const start = currentTime;
    await rpc(this, relay, 'ping');
    return [relay, currentTime - start];
  }

  async publishStream(streamId: number) {
    const homeRelay = await this.findHomeRelay();
    if(homeRelay === null) {
      this.failed = true;
      await sleep(10000);
      await this.shutdown();
      return;
    }

    // Establish stream
    addStreamConnection(this, homeRelay, streamId);
  }

  async subscribeStream(streamId: number) {
    const homeRelay = await this.findHomeRelay();
    if(homeRelay === null) {
      this.failed = true;
      await sleep(10000);
      await this.shutdown();
      return;
    }

    // Ask control where to subscribe
    const relays = control.askSubscribe(homeRelay, streamId);
    if(relays.length === 0) {
      console.log(this.name + " got no way to subscribe to stream " + streamId);
      if(streams.findIndex(s => s === streamId) !== -1) {
        console.error(this.name + " couldn't subscribe to stream " + streamId + " that still exists", streams);
        this.failed = true;
        await sleep(10000);
      } // If stream is gone, this is not an error

      await this.shutdown();
      return;
    }

    // Establish stream with the first proposed relay
    addStreamConnection(relays[0], this, streamId);
  }

  async shutdown() {
    this.running = false;

    // Remove from the clients
    const idx = clients.findIndex(c => c.name === this.name);
    if(idx !== -1) {
      clients.splice(idx, 1);
    }

    // Remove the connections
    for(const connection of Object.values(this.connections)) {
      delete connection.source.connections[connection.id];
      delete connection.target.connections[connection.id];
      delete connections[connection.id];
    }
  }
}

class Relay implements Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};
  zone: string;
  running: boolean;

  constructor(name: string, position: [number, number], zone: string) {
    this.name = name;
    this.position = position;
    this.zone = zone;
    this.running = true;

    this.connections = {};
  }

  latency(): number {
    return 2;
  }

  async getStream(streamId: number): Promise<void> {
    for(const connection of Object.values(this.connections)) {
      if(connection.target === this && connection.streamId === streamId) {
        // We are already receiving this stream
        return;
      }
    }
    // TODO: Get that stream from another relay
  }

  async ping(): Promise<void> {
  }

  isOverloaded(): boolean {
    return Object.values(this.connections).length >= RELAY_MAX_CONNECTIONS;
  }
}

abstract class Control {
  abstract listRelays(): Relay[];
  abstract askSubscribe(homeRelay: Relay, streamId: number): Relay[];
}

// Scenario
const relays = [
  new Relay('us-ny-1', [90, 80], 'us-ny'),
  new Relay('us-ny-2', [90, 85], 'us-ny'),
  new Relay('us-az-1', [50, 95], 'us-az'),
  new Relay('us-az-2', [55, 95], 'us-az'),
];

const clients: Client[] = [];
const streams: number[] = [];
let nextStreamId = 0;

// Simulation
function addClients() {
  let redraw = false;

  // Chance of adding a client
  if(clients.length < MAX_CLIENTS && Math.random() < CLIENT_ADD_PROBA) {
    const name = 'client-' + Math.floor(Math.random() * 10000);
    console.log("Creating " + name);
    const client = new Client(
      name,
      [5 + Math.random() * 90, 5 + Math.random() * 90],
    );
    clients.push(client);

    // 20% chance it wants to publish, 80% chance it wants to subscribe
    if(streams.length === 0 || Math.random() < 0.2) {
      // Publish a stream
      const streamId = nextStreamId++;
      client.publishedStream = streamId;
      console.log(name + " will publish " + streamId);
      client.publishStream(streamId).then(() => {
        if(client.running) {
          streams.push(streamId);
        }
      });
    } else {
      // Subscribe to a stream
      const streamId = streams[Math.floor(Math.random() * streams.length)];
      console.log(name + " will subscribe " + streamId);
      client.subscribeStream(streamId);
    }

    redraw = true;
  }

  // Chance of removing a client
  if(clients.length > 5 && Math.random() < CLIENT_REMOVE_PROBA) {
    const idx = Math.floor(Math.random() * clients.length);
    const client = clients[idx];
    console.log("Shutting down " + client.name);
    if(client.publishedStream !== undefined) {
      const streamIdx = streams.findIndex((s) => s === client.publishedStream);
      if(streamIdx !== -1) {
        console.log("Shutting down stream " + client.publishedStream);
        streams.splice(streamIdx, 1);
      }
    }
    client.shutdown();

    redraw = true;
  }

  if(redraw) {
    draw();
  }

  addTimeout(addClients, CLIENT_CHANGE_RATE);
}
addTimeout(addClients, CLIENT_CHANGE_RATE);

// Control logic
class ControlImpl extends Control {
  streams: {[id: string]: {firstRelay: Relay}};

  constructor() {
    super();
    this.streams = {};
  }

  listRelays(): Relay[] {
    // Pick one relay per zone
    const zones: {[zone: string]: Relay} = {};
    for(const relay of relays) {
      if(relay.isOverloaded()) {
        // Overloaded, skip
        continue;
      }
      const relayConnections = Object.values(relay.connections).length;

      if(zones[relay.zone] === undefined) {
        // No pick yet, pick this
        zones[relay.zone] = relay;
      } else {
        const prevConnections = Object.values(zones[relay.zone].connections).length;
        if(relayConnections < prevConnections) {
          // This is better than previous pick
          zones[relay.zone] = relay;
        }
      }
    }

    return Object.values(zones);
  }

  askSubscribe(homeRelay: Relay, streamId: number): Relay[] {
    const candidates = [];

    // Find the source relay for that stream
    //const sourceRelay = this.streams[streamId].firstRelay;
    let sourceRelay: Relay | undefined = undefined;
    for(const relay of relays) {
      for(const connection of Object.values(relay.connections)) {
        if(connection.streamId === streamId && connection.source instanceof Client) {
          sourceRelay = connection.target as Relay;
        }
      }
    }
    if(sourceRelay === undefined) {
      if(streams.findIndex(s => s === streamId) !== -1) {
        console.error("control couldn't find source relay for stream " + streamId + " that still exists", streams);
      }
      return [];
    }

    // If not overloaded, it's a candidate
    if(!sourceRelay.isOverloaded()) {
      candidates.push(sourceRelay);
    }

    let foundRelayInHomeZone = false;
    // Try to find another relay in the home zone that's not overloaded and already has the stream
    for(const otherHomeRelay of relays) {
      if(
        otherHomeRelay.zone === homeRelay.zone
        && !otherHomeRelay.isOverloaded()
      ) {
        for(const connection of Object.values(otherHomeRelay.connections)) {
          if(
            connection.target === otherHomeRelay
            && connection.streamId === streamId
          ) {
            candidates.push(otherHomeRelay);
            foundRelayInHomeZone = true;
          }
        }
      }
    }

    // Add the client's home relay
    if(!foundRelayInHomeZone) {
      candidates.push(homeRelay);
    }
    return candidates;
  }
}

control = new ControlImpl();

// Rendering
function draw() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = 16;
  ctx.font = 'bold ' + fontSize + 'px serif';

  // Compute amount of traffic between peers
  const traffic: {[key: string]: {source: Peer; target: Peer; amount: number}} = {};
  for(const connection of Object.values(connections)) {
    const key = connection.source.name + ':' + connection.target.name;
    if(traffic[key] === undefined) {
      traffic[key] = {source: connection.source, target: connection.target, amount: 0};
    }
    traffic[key].amount += 1;
  }

  // Draw links
  for(const link of Object.values(traffic)) {
    let source = [link.source.position[0] / 100 * width, link.source.position[1] / 100 * height];
    let target = [link.target.position[0] / 100 * width, link.target.position[1] / 100 * height];

    // Move each endpoint to the side, to make way for the reverse link
    let dx = target[0] - source[0];
    let dy = target[1] - source[1];
    let len = Math.sqrt(dx * dx + dy * dy);
    dx /= len;
    dy /= len;
    source[0] += dy * 10;
    source[1] -= dx * 10;
    target[0] += dy * 10;
    target[1] -= dx * 10;

    ctx.lineWidth = link.amount;
    ctx.beginPath();
    ctx.moveTo(source[0], source[1]);
    ctx.lineTo(target[0], target[1]);
    ctx.stroke();
    ctx.lineWidth = 1;

    // Draw the arrow
    ctx.beginPath();
    ctx.moveTo(target[0] - dx * 5 + dy * 5, target[1] - dy * 5 - dx * 5);
    ctx.lineTo(target[0], target[1]);
    ctx.lineTo(target[0] - dx * 5 - dy * 5, target[1] - dy * 5 + dx * 5);
    ctx.stroke();
  }

  // Draw relays
  ctx.strokeStyle = '#f28282';
  for(const relay of relays) {
    if(relay.isOverloaded()) {
      ctx.beginPath();
      ctx.moveTo(relay.position[0] / 100.0 * width - 30, relay.position[1] / 100.0 * height);
      ctx.lineTo(relay.position[0] / 100.0 * width + 30, relay.position[1] / 100.0 * height);
      ctx.stroke();
      ctx.fillStyle = '#9f87f9';
    } else {
      ctx.fillStyle = 'blue';
    }
    ctx.fillText(relay.name, relay.position[0] / 100.0 * width, relay.position[1] / 100.0 * height);
  }

  // Draw clients
  ctx.fillStyle = '#008056';
  for(const client of clients) {
    ctx.fillText(client.name,  client.position[0] / 100.0 * width, client.position[1] / 100.0 * height);
    if(client.publishedStream !== undefined) {
      ctx.fillText('' + client.publishedStream, client.position[0] / 100.0 * width, client.position[1] / 100.0 * height + fontSize);
    }
    if(client.failed) {
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(client.position[0] / 100.0 * width - 20, client.position[1] / 100.0 * height - 20);
      ctx.lineTo(client.position[0] / 100.0 * width + 20, client.position[1] / 100.0 * height + 20);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(client.position[0] / 100.0 * width - 20, client.position[1] / 100.0 * height + 20);
      ctx.lineTo(client.position[0] / 100.0 * width + 20, client.position[1] / 100.0 * height - 20);
      ctx.stroke();
    }
  }

  const info = document.getElementById('info')!;
  info.innerHTML = clients.length + ' clients, ' + streams.length + ' streams, ' + Object.values(connections).length + ' connections';
}

window.addEventListener('resize', draw);
draw();
