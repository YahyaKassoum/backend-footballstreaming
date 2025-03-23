const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

let worker;
let router;
const matchTransports = {};
const matchProducers = {};
const matchConsumers = {};

// ✅ Initialize Mediasoup Worker & Router (Once on server startup)
const createMediasoupWorker = async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
      { kind: "video", mimeType: "video/H264", clockRate: 90000, parameters: { "packetization-mode": 1 } },
    ],
  });
  console.log("✅ Mediasoup Worker & Router initialized");
};

createMediasoupWorker();

// ✅ Get RTP Capabilities (Always Available)
app.get("/api/rtp-capabilities", (req, res) => {
  if (!router) return res.status(500).json({ error: "Router not initialized" });
  res.json(router.rtpCapabilities);
});

// ✅ Create Transport (Persistent, Not Reinitialized)
app.post("/api/create-transport", async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: "Match ID is required" });

  try {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "127.0.0.1", announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    if (!matchTransports[matchId]) matchTransports[matchId] = {};
    matchTransports[matchId][transport.id] = transport;

    res.json({
      transportOptions: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });
  } catch (error) {
    console.error("❌ Error creating transport:", error);
    res.status(500).json({ error: "Transport creation failed" });
  }
});

// ✅ Connect Transport (Persistent, Match-Specific)
app.post("/api/connect-transport", async (req, res) => {
  const { matchId, transportId, dtlsParameters } = req.body;
  if (!matchId || !transportId) return res.status(400).json({ error: "Match ID and Transport ID are required" });

  const transport = matchTransports[matchId]?.[transportId];
  if (!transport) return res.status(404).json({ error: "Transport not found" });

  try {
    await transport.connect({ dtlsParameters });
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error connecting transport:", error);
    res.status(500).json({ error: "Transport connection failed" });
  }
});

// ✅ Produce Stream (Match-Specific Producers)
app.post("/api/produce", async (req, res) => {
  const { matchId, transportId, kind, rtpParameters } = req.body;
  
  if (!matchId || !transportId || !kind || !rtpParameters) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const transport = matchTransports[matchId]?.[transportId];
  if (!transport) return res.status(404).json({ error: "Transport not found" });

  try {
    const producer = await transport.produce({ kind, rtpParameters });

    if (!matchProducers[matchId]) matchProducers[matchId] = {};
    matchProducers[matchId][producer.id] = producer;

    // Set up producer close handler
    producer.on("transportclose", () => {
      console.log(`Producer ${producer.id} closed due to transport closure`);
      if (matchProducers[matchId]?.[producer.id]) {
        delete matchProducers[matchId][producer.id];
      }
    });

    res.json({ id: producer.id });
  } catch (error) {
    console.error("❌ Error producing stream:", error);
    res.status(500).json({ error: "Production failed", details: error.message });
  }
});

// ✅ Consume Stream (Persistent Consumers)
app.post("/api/consume", async (req, res) => {
  const { matchId, transportId, rtpCapabilities } = req.body;
  if (!matchId || !transportId || !rtpCapabilities) return res.status(400).json({ error: "Missing required fields" });

  const transport = matchTransports[matchId]?.[transportId];
  if (!transport) return res.status(404).json({ error: "Transport not found" });

  // Find any available producer
  const producers = matchProducers[matchId] || {};
  const producerIds = Object.keys(producers);
  
  if (producerIds.length === 0) {
    return res.status(404).json({ error: "No producer available" });
  }

  // Use the first available producer
  const producer = producers[producerIds[0]];

  if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
    return res.status(400).json({ error: "Cannot consume this producer" });
  }

  try {
    const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities, paused: false });

    if (!matchConsumers[matchId]) matchConsumers[matchId] = {};
    matchConsumers[matchId][consumer.id] = consumer;

    // Set up consumer close handler
    consumer.on("transportclose", () => {
      console.log(`Consumer ${consumer.id} closed due to transport closure`);
      if (matchConsumers[matchId]?.[consumer.id]) {
        delete matchConsumers[matchId][consumer.id];
      }
    });

    res.json({
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  } catch (error) {
    console.error("❌ Error consuming stream:", error);
    res.status(500).json({ error: "Consumption failed", details: error.message });
  }
});

// ✅ NEW: Get stream status for a match
app.get("/api/stream-status/:matchId", (req, res) => {
  const { matchId } = req.params;
  
  const hasProducers = matchProducers[matchId] && 
                       Object.keys(matchProducers[matchId]).length > 0;
  
  res.json({
    isActive: hasProducers,
    producerCount: hasProducers ? Object.keys(matchProducers[matchId]).length : 0
  });
});

// ✅ NEW: Clean up a specific producer
app.post("/api/close-producer", async (req, res) => {
  const { matchId, producerId } = req.body;
  if (!matchId || !producerId) return res.status(400).json({ error: "Match ID and Producer ID required" });

  try {
    const producer = matchProducers[matchId]?.[producerId];
    if (producer) {
      producer.close();
      delete matchProducers[matchId][producerId];
      console.log(`✅ Producer ${producerId} closed successfully`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error closing producer:", error);
    res.status(500).json({ error: "Failed to close producer" });
  }
});

// ✅ NEW: Clean up a specific transport
app.post("/api/close-transport", async (req, res) => {
  const { matchId, transportId } = req.body;
  if (!matchId || !transportId) return res.status(400).json({ error: "Match ID and Transport ID required" });

  try {
    const transport = matchTransports[matchId]?.[transportId];
    if (transport) {
      transport.close();
      delete matchTransports[matchId][transportId];
      console.log(`✅ Transport ${transportId} closed successfully`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error closing transport:", error);
    res.status(500).json({ error: "Failed to close transport" });
  }
});

// ✅ NEW: Clean up all resources for a match
app.post("/api/cleanup-match", async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: "Match ID required" });

  try {
    // Close all producers
    if (matchProducers[matchId]) {
      Object.values(matchProducers[matchId]).forEach(producer => producer.close());
      delete matchProducers[matchId];
    }
    
    // Close all consumers
    if (matchConsumers[matchId]) {
      Object.values(matchConsumers[matchId]).forEach(consumer => consumer.close());
      delete matchConsumers[matchId];
    }
    
    // Close all transports
    if (matchTransports[matchId]) {
      Object.values(matchTransports[matchId]).forEach(transport => transport.close());
      delete matchTransports[matchId];
    }
    
    console.log(`✅ All resources for match ${matchId} cleaned up`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error cleaning up match resources:", error);
    res.status(500).json({ error: "Failed to clean up match resources" });
  }
});

// ✅ Start the Server (Persistent, No Restart)
const PORT = 3001;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));