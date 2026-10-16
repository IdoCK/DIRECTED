// End-to-end test for the print stop flow, run against the real server in
// simulation mode (no printer attached):
//   1. start a print and stop it mid-layer
//   2. assert no layer events arrive after print_stopped (zombie loop guard)
//   3. assert a second print session can home and start after the stop
//
// Run with: npm test
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:5000';
const projectRoot = path.join(__dirname, '..');

const layers = Array.from({ length: 6 }, (_, i) => ({
    points: [
        { x: 10 + i, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 },
        { x: 10, y: 30 }, { x: 10 + i, y: 10 },
    ],
    user_made: true,
}));

function startServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const onData = (data) => {
            if (data.toString().includes('Server running on port')) {
                child.stdout.off('data', onData);
                resolve(child);
            }
        };
        child.stdout.on('data', onData);
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
        setTimeout(() => reject(new Error('server did not start within 10s')), 10000).unref();
    });
}

function runClient() {
    return new Promise((resolve) => {
        const sock = io(SERVER_URL, { transports: ['websocket'] });
        const t0 = Date.now();
        const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);

        let phase = 'first-print';
        let stopped = false;
        let zombieEvents = 0;
        let secondHomingDone = false;

        const finish = () => {
            sock.close();
            resolve({ zombieEvents, secondHomingDone });
        };

        sock.on('connect', () => { log('connected, starting program'); sock.emit('programStarted'); });

        sock.on('homing_complete', () => {
            if (phase === 'first-print') {
                log('homing complete, sending 6 layers');
                sock.emit('layersUpdate', { layers });
            } else {
                log('second homing complete - restart after stop works');
                secondHomingDone = true;
                finish();
            }
        });

        sock.on('layerStarted', ({ layerIndex }) => {
            log(`layerStarted ${layerIndex + 1}`);
            if (stopped) { zombieEvents++; log('!! zombie layerStarted after stop'); }
            if (phase === 'first-print' && layerIndex === 0) {
                setTimeout(() => { log('issuing stop_print mid-layer'); sock.emit('stop_print'); }, 350);
            }
        });

        sock.on('layerCompleted', ({ layerIndex }) => {
            if (stopped) { zombieEvents++; log(`!! zombie layerCompleted ${layerIndex + 1} after stop`); }
        });

        sock.on('print_stopped', () => {
            log('print_stopped received, watching 4s for zombie layer events');
            stopped = true;
            setTimeout(() => {
                if (zombieEvents > 0) return finish();
                log('no zombie events - issuing second programStarted');
                phase = 'second-print';
                stopped = false;
                sock.emit('programStarted');
            }, 4000);
        });

        setTimeout(() => { log('client timeout'); finish(); }, 25000).unref();
    });
}

(async () => {
    let server;
    try {
        server = await startServer();
        const { zombieEvents, secondHomingDone } = await runClient();

        const pass = zombieEvents === 0 && secondHomingDone;
        console.log(pass
            ? 'PASS: stop halts printing and a new session can start'
            : `FAIL: zombieEvents=${zombieEvents}, restartAfterStop=${secondHomingDone}`);
        process.exitCode = pass ? 0 : 1;
    } catch (err) {
        console.error('FAIL:', err.message);
        process.exitCode = 1;
    } finally {
        if (server) server.kill();
    }
})();
