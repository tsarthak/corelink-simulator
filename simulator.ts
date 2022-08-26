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
        console.log("Simulation time: " + currentTime);
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
let control: Control | undefined;

interface Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};

  latency(): number;
}

async function rpc(source: Peer, target: Peer, method: string, ...args: any[]) {
  // Measure latency between source and target
  const dx = source.position[0] - target.position[0];
  const dy = source.position[1] - target.position[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const latency = dist + source.latency() + target.latency();

  // Wait to simulate travel time of packet
  await sleep(latency * 50);

  // Call target function
  const result = await (target as unknown as any)[method](...args);

  // Wait to simulate travel time back
  await sleep(latency * 50);

  // Return
  return result;
}

interface Connection {
  id: string;
  fromPeer: Peer;
  toPeer: Peer;
}

class Client implements Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};

  latency(): number {
    return 20;
  }

  constructor(name: string, position: [number, number]) {
    this.name = name;
    this.position = position;

    this.connections = {};
  }

  async findHomeRelay(): Promise<Relay> {
    // Get the list of relays from control
    const availableRelays = await control!.listRelays();

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

    // TODO
  }

  async subscribeStream(streamId: number) {
    const homeRelay = await this.findHomeRelay();

    // TODO
  }

  async shutdown() {
    // TODO
  }
}

class Relay implements Peer {
  name: string;
  position: [number, number];
  connections: {[id: string]: Connection};
  zone: string;

  constructor(name: string, position: [number, number], zone: string) {
    this.name = name;
    this.position = position;
    this.zone = zone;

    this.connections = {};
  }

  latency(): number {
    return 2;
  }

  async ping(): Promise<void> {
  }
}

abstract class Control {
  abstract listRelays(): Relay[];
}

// Scenario
const relays = [
  new Relay('us-ny-1', [100, 80], 'us-ny'),
  new Relay('us-ny-2', [100, 85], 'us-ny'),
  new Relay('us-az-1', [50, 95], 'us-az'),
  new Relay('us-az-2', [55, 95], 'us-az'),
];

const clients: Client[] = [];
const streams: number[] = [];
let nextStreamId = 0;

// Simulation
function addClients() {
  // 20% chance of adding a client
  if(clients.length < 100 && Math.random() < 0.2) {
    const name = 'client-' + Math.floor(Math.random() * 10000);
    console.log("Creating " + name);
    const client = new Client(
      name,
      [Math.random() * 200, Math.random() * 100],
    );
    clients.push(client);

    // 20% chance it wants to publish, 80% chance it wants to subscribe
    if(streams.length === 0 || Math.random() < 0.2) {
      // Publish a stream
      const streamId = nextStreamId++;
      console.log(name + " will publish " + streamId);
      streams.push(streamId);
      client.publishStream(streamId);
    } else {
      // Subscribe to a stream
      const streamId = streams[Math.floor(Math.random() * streams.length)];
      console.log(name + " will subscribe " + streamId);
      client.subscribeStream(streamId);
    }
  }

  // 15% chance of removing a client
  if(clients.length > 5 && Math.random() < 0.15) {
    const idx = Math.floor(Math.random() * clients.length);
    const client = clients[idx];
    client.shutdown();
    clients.splice(idx, 1);
    console.log("Shutting down " + client.name);
  }

  addTimeout(addClients, 1000);
}
addTimeout(addClients, 1000);

// Control logic
interface ControlRelay {}

class ControlImpl extends Control {
  relays: {[name: string]: ControlRelay};
  streams: {[id: string]: {firstRelay: string}};

  constructor() {
    super();
    this.relays = {};
    this.streams = {};
  }

  listRelays(): Relay[] {
    // TODO: Pick one relay per zone
    return relays;
  }
}

control = new ControlImpl();

// Rendering
function draw() {
  // TODO
}
