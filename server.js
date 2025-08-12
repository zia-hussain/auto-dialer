// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const { Server } = require('socket.io');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ---- Twilio ----
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---- Dialer State ----
let callQueue = [];           // [{ phone: "+1..." }, ...]
let idx = 0;                  // current index
let calling = false;          // dialer active?
let autoNext = true;          // auto-advance?
let callSidQueue = [];        // active SIDs
let isAdvancing = false;      // mutex to stop double-Next
let manualAdvanceFlag = false;// to suppress status double increment

// ---- Helpers ----
function loadNumbers() {
    const raw = fs.readFileSync('./numbers.json', 'utf8');
    const obj = JSON.parse(raw);
    callQueue = Array.isArray(obj) ? obj : Object.values(obj);
}

function emitState() {
    const currentNumber = idx < callQueue.length ? callQueue[idx]?.phone : null;
    io.emit('dialer-state', {
        currentNumber,
        index: idx,
        calling,
        autoNext,
        remaining: Math.max(callQueue.length - idx, 0),
    });
}

async function cleanupCalls({ rejectAll = false, keepSid = null } = {}) {
    const toCancel = rejectAll ? [...callSidQueue] : callSidQueue.filter(s => s !== keepSid);
    for (const sid of toCancel) {
        try { await twilioClient.calls(sid).update({ status: 'completed' }); }
        catch (e) { /* noop */ }
    }
    callSidQueue = rejectAll ? [] : keepSid ? [keepSid] : [];
}

async function dialNext() {
    // out of numbers
    if (idx >= callQueue.length) {
        await cleanupCalls({ rejectAll: true });
        calling = false;
        emitState();
        return;
    }
    if (!calling) return;
    if (!autoNext && !manualAdvanceFlag) return;

    const target = callQueue[idx];
    if (!target || !target.phone) {
        idx++;
        return dialNext();
    }

    // ensure no parallel calls are running
    if (callSidQueue.length > 0) await cleanupCalls({ rejectAll: true });

    try {
        const call = await twilioClient.calls.create({
            to: target.phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: `${process.env.PUBLIC_BASE_URL}/twiml/outbound?type=autodialer`,
            statusCallback: `${process.env.PUBLIC_BASE_URL}/webhooks/status`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'busy', 'no-answer', 'failed', 'canceled'],
        });
        callSidQueue.push(call.sid);
        manualAdvanceFlag = false;
        emitState();
    } catch (err) {
        // skip bad numbers and continue
        idx++;
        emitState();
        return dialNext();
    }
}

// ---- Socket.io (optional realtime UI) ----
io.on('connection', socket => { emitState(); });

// ---- Public endpoints ----

// Reset everything (you asked for one-click reset)
app.post('/api/reset', async (req, res) => {
    await cleanupCalls({ rejectAll: true });
    loadNumbers();
    idx = 0;
    calling = false;
    autoNext = true;
    isAdvancing = false;
    manualAdvanceFlag = false;
    emitState();
    res.json({ success: true, status: 'State reset' });
});

// Start dialer from beginning
app.post('/api/start', async (req, res) => {
    if (calling) return res.json({ success: false, status: 'Already running' });
    loadNumbers();
    idx = 0;
    calling = true;
    emitState();
    dialNext();
    res.json({ success: true, status: 'Started' });
});

// Start from specific index
app.post('/api/start-from', async (req, res) => {
    const { index } = req.body || {};
    loadNumbers();
    if (index < 0 || index >= callQueue.length) {
        return res.json({ success: false, status: 'Invalid index' });
    }
    await cleanupCalls({ rejectAll: true });
    idx = index;
    calling = true;
    emitState();
    dialNext();
    res.json({ success: true, status: `Started from ${index}` });
});

// Full stop
app.post('/api/stop', async (req, res) => {
    calling = false;
    await cleanupCalls({ rejectAll: true });
    emitState();
    res.json({ success: true, status: 'Stopped' });
});

// Toggle auto-next
app.post('/api/auto-next', (req, res) => {
    autoNext = !!req.body?.enabled;
    if (autoNext && calling && callSidQueue.length === 0) dialNext();
    emitState();
    res.json({ success: true, status: `AutoNext ${autoNext ? 'ON' : 'OFF'}` });
});

// Manual next
app.post('/api/next', async (req, res) => {
    if (!calling) return res.json({ success: false, status: 'Not running' });
    if (isAdvancing) return res.json({ success: false, status: 'Please wait…' });

    isAdvancing = true;
    manualAdvanceFlag = true;

    // terminate any live call first
    await cleanupCalls({ rejectAll: true });

    idx++;
    emitState();

    if (idx < callQueue.length) {
        res.json({ success: true, status: 'Next dialing…', currentNumber: callQueue[idx].phone });
        await dialNext();
    } else {
        calling = false;
        emitState();
        res.json({ success: false, status: 'No more numbers' });
    }
    isAdvancing = false;
});

// Get current state
app.get('/api/state', (req, res) => {
    const currentNumber = idx < callQueue.length ? callQueue[idx]?.phone : null;
    res.json({ currentNumber, index: idx, calling, autoNext, remaining: Math.max(callQueue.length - idx, 0) });
});

// ---- TwiML (what Twilio plays/dials) ----
app.post('/twiml/outbound', (req, res) => {
    const twiml = new VoiceResponse();
    // Here we just connect to a client to bridge into browser if you want,
    // or play a message, or leave it empty to ring the callee.
    // For now, keep it simple – just let it ring through.
    twiml.say('Connecting your call.');
    res.type('text/xml').send(twiml.toString());
});

// ---- Twilio Status Webhook ----
app.post('/webhooks/status', async (req, res) => {
    const callStatus = req.body.CallStatus;
    const callSid = req.body.CallSid;
    const direction = req.body.Direction;
    const conferenceSid = req.body.ConferenceSid || null;

    // ignore inbound or conference noise
    if (conferenceSid || (direction && direction.includes('inbound'))) {
        return res.sendStatus(200);
    }

    // prune this sid from active list (idempotent)
    callSidQueue = callSidQueue.filter(s => s !== callSid);

    // move forward only when a call has a terminal status
    if (['busy', 'failed', 'no-answer', 'canceled', 'completed'].includes(callStatus)) {
        // If this advancement was triggered by manual next, do not double-increment here.
        if (calling && (autoNext || manualAdvanceFlag)) {
            idx++;
            manualAdvanceFlag = false;
            emitState();
            await dialNext();
        }
    }
    res.sendStatus(200);
});

// ---- Boot ----
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Dialer running on ${PORT}`));
