import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import GraphQLJSON from 'graphql-type-json';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const typeDefs = /* GraphQL */ `
  scalar JSONObject

  type Query {
    hello: String!
    events(limit: Int!, seed: Int!): [Event!]!
  }

  type Event {
    id: ID!
    title: String!
    tags: [String!]!
    payload: EventPayload!
  }

  union EventPayload = TextPayload | JsonPayload

  type TextPayload {
    message: JSONObject!
    severity: Int!
    annotations: [Annotation!]!
    metadata: JSONObject!
  }

  type Annotation {
    key: String!
    value: String!
  }

  type JsonPayload {
    data: JSONObject!
  }
`;

const resolvers = {
  JSONObject: GraphQLJSON,
  Query: {
    hello: () => 'Hello from the GraphQL server!',
    events: (_, args) => generateEvents(args),
  },
  Event: {
    payload: (event) => event.payload,
  },
  EventPayload: {
    __resolveType: (payload) => payload.__typename,
  },
};

const server = new ApolloServer({ typeDefs, resolvers });
await server.start();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

app.use(cors());
app.use(bodyParser.json());

const sseClients = new Set();
let latestMetrics = null;

const broadcastMetrics = (snapshot) => {
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
};

app.get('/metrics-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);

  if (latestMetrics) {
    res.write(`data: ${JSON.stringify(latestMetrics)}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/metrics', (req, res) => {
  const snapshot = req.body;
  if (!snapshot || typeof snapshot !== 'object') {
    res.status(400).json({ error: 'Invalid metrics payload' });
    return;
  }

  latestMetrics = snapshot;
  broadcastMetrics(snapshot);
  res.status(204).end();
});

app.use('/graphql', expressMiddleware(server));
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`🚀 GraphQL server ready at http://${HOST}:${PORT}/graphql`);
});

const MAX_EVENTS = 8000;
const TAG_POOL = [
  'cache',
  'network',
  'graphql',
  'deserialization',
  'load-test',
  'production',
  'canary',
];
const ANNOTATION_KEYS = [
  'region',
  'az',
  'version',
  'build',
  'host',
  'checksum',
  'feature',
];

const generateEvents = ({ limit, seed }) => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, MAX_EVENTS)) : 100;
  const safeSeed = Number.isFinite(seed) ? seed : 1;
  const random = mulberry32(safeSeed);
  const events = [];

  for (let index = 0; index < safeLimit; index += 1) {
    const id = `evt-${safeSeed}-${index}`;
    const isJsonPayload = index % 7 === 0;
    const severity = randomInt(random, 0, 5);
    const baseTitle = isJsonPayload ? 'JSON' : 'TEXT';
    const event = {
      id,
      title: `${baseTitle} payload ${index}`,
      tags: buildTags(random),
      payload: isJsonPayload
        ? {
            __typename: 'JsonPayload',
            data: buildJsonBlob(random, index),
          }
        : {
            __typename: 'TextPayload',
            message: buildLargeMessageObject(random, index),
            severity,
            annotations: buildAnnotations(random),
            metadata: buildTextMetadata(random, index, severity),
          },
    };
    events.push(event);
  }

  return events;
};

const mulberry32 = (seed) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInt = (random, min, max) => Math.floor(random() * (max - min + 1)) + min;

const buildTags = (random) => {
  const count = randomInt(random, 2, TAG_POOL.length);
  const chosen = new Set();
  while (chosen.size < count) {
    chosen.add(TAG_POOL[randomInt(random, 0, TAG_POOL.length - 1)]);
  }
  return Array.from(chosen);
};

const buildAnnotations = (random) => {
  const count = randomInt(random, 2, 6);
  const annotations = [];
  for (let i = 0; i < count; i += 1) {
    const key = ANNOTATION_KEYS[randomInt(random, 0, ANNOTATION_KEYS.length - 1)];
    annotations.push({
      key,
      value: `${key}-${randomInt(random, 1, 9999)}`,
    });
  }
  return annotations;
};

const buildLargeMessageObject = (random, index) => {
  const segmentCount = randomInt(random, 350, 900);
  const chunks = [];
  for (let i = 0; i < segmentCount; i += 1) {
    chunks.push({
      id: `seg-${index}-${i}`,
      text: randomString(random, randomInt(random, 600, 1500)),
      weight: random(),
      tags: buildTags(random),
    });
  }
  return {
    format: 'structured-v2',
    text: chunks.slice(0, 50).map((chunk) => chunk.text).join('|'),
    chunks,
    heatmap: buildHeatmap(random, index),
  };
};

const buildTextMetadata = (random, index, severity) => ({
  version: `v${1 + (index % 5)}`,
  severityBucket: severity >= 4 ? 'critical' : severity >= 2 ? 'warning' : 'info',
  thresholds: {
    p50: random() * 100,
    p90: random() * 200,
    p99: random() * 500,
  },
  flags: {
    cacheBypassed: random() > 0.75,
    degraded: random() > 0.6,
    fallbackTriggered: random() > 0.4,
  },
  timeline: Array.from({ length: randomInt(random, 80, 160) }, (_, i) => ({
    second: i,
    qps: random() * 5000,
    errorRate: random(),
  })),
  annotations: buildAnnotations(random),
});

const buildHeatmap = (random, index) => {
  const days = randomInt(random, 7, 14);
  const heatmap = [];
  for (let day = 0; day < days; day += 1) {
    const rows = [];
    for (let hour = 0; hour < 24; hour += 1) {
      rows.push({
        slot: `${index}-${day}-${hour}`,
        load: random(),
        jitter: random(),
      });
    }
    heatmap.push(rows);
  }
  return heatmap;
};

const randomString = (random, length) => {
  let buffer = '';
  while (buffer.length < length) {
    buffer += random().toString(36).slice(2);
  }
  return buffer.slice(0, length);
};

const buildJsonBlob = (random, index) => {
  const sections = randomInt(random, 10, 25);
  const payload = {};
  for (let section = 0; section < sections; section += 1) {
    const key = `section_${index}_${section}`;
    const nested = [];
    const entries = randomInt(random, 25, 60);
    for (let e = 0; e < entries; e += 1) {
      nested.push({
        bucket: `b-${section}-${e}`,
        count: randomInt(random, 0, 5000),
        latency: {
          p50: random() * 100,
          p90: random() * 200,
          p99: random() * 500,
        },
        checksum: random().toString(16).slice(2, 10),
      });
    }
    payload[key] = {
      summary: {
        max: nested.reduce((max, item) => Math.max(max, item.count), 0),
        mean: nested.reduce((sum, item) => sum + item.count, 0) / nested.length,
      },
      nested,
    };
  }
  return payload;
};
