const statusEl = document.getElementById('status');
const currentEl = document.getElementById('current');
const idxEl = document.getElementById('index');
const remEl = document.getElementById('remaining');
const autoNextToggle = document.getElementById('autoNext');

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const nextBtn = document.getElementById('next');
const resetBtn = document.getElementById('reset');
const startFromBtn = document.getElementById('startFrom');
const startIndexInput = document.getElementById('startIndex');

const socket = io(); // same origin

socket.on('dialer-state', (data) => {
    currentEl.textContent = data.currentNumber || '—';
    idxEl.textContent = data.index ?? 0;
    remEl.textContent = data.remaining ?? 0;

    if (!data.calling) statusEl.textContent = 'Idle';
    else if (!data.autoNext) statusEl.textContent = 'Manual mode — click Next';
    else statusEl.textContent = 'Dialing…';

    autoNextToggle.checked = !!data.autoNext;
});

async function post(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : '{}'
    });
    return res.json().catch(() => ({}));
}

startBtn.onclick = async () => { await post('/api/start'); };
stopBtn.onclick = async () => { await post('/api/stop'); };
nextBtn.onclick = async () => { await post('/api/next'); };
resetBtn.onclick = async () => { await post('/api/reset'); };

startFromBtn.onclick = async () => {
    const n = parseInt(startIndexInput.value, 10);
    if (Number.isNaN(n) || n < 0) return alert('Enter a valid index');
    await post('/api/start-from', { index: n });
};

autoNextToggle.onchange = async () => {
    await post('/api/auto-next', { enabled: autoNextToggle.checked });
};

// get initial state once page loads (in case socket is late)
fetch('/api/state').then(r => r.json()).then(data => {
    currentEl.textContent = data.currentNumber || '—';
    idxEl.textContent = data.index ?? 0;
    remEl.textContent = data.remaining ?? 0;
    statusEl.textContent = data.calling ? (data.autoNext ? 'Dialing…' : 'Manual mode — click Next') : 'Idle';
    autoNextToggle.checked = !!data.autoNext;
});
