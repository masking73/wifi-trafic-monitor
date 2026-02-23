const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const si = require('systeminformation');

// --- Server Logic (Internal) ---
const expressApp = express();
const server = http.createServer(expressApp);
const io = socketIo(server);

expressApp.use(express.static(path.join(__dirname, 'public')));

let knownApps = new Set();
let currentDNS = [];
let lastRx = 0;
let lastTx = 0;
let lastTime = Date.now();
let initialized = false;

async function getNetworkData() {
    try {
        const [stats, connections, interfaces] = await Promise.all([
            si.networkStats(),
            si.networkConnections(),
            si.networkInterfaces()
        ]);

        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000;
        
        let totalRx = 0;
        let totalTx = 0;
        stats.forEach(iface => {
            totalRx += iface.rx_bytes;
            totalTx += iface.tx_bytes;
        });

        if (lastRx === 0) {
            lastRx = totalRx;
            lastTx = totalTx;
        }

        const rx_sec = (totalRx - lastRx) / timeDiff;
        const tx_sec = (totalTx - lastTx) / timeDiff;
        lastRx = totalRx;
        lastTx = totalTx;
        lastTime = now;

        const activeConnections = connections.filter(c => c.state === 'ESTABLISHED');
        const uniqueConnections = [];
        
        activeConnections.forEach(conn => {
            const appName = conn.process || 'Unknown';
            if (appName !== 'Unknown') {
                if (initialized) {
                    if (!knownApps.has(appName)) {
                        knownApps.add(appName);
                        io.emit('alert', { type: 'New App', message: `Detected activity from: ${appName}` });
                    }
                } else {
                    knownApps.add(appName);
                }
            }

            uniqueConnections.push({
                processName: appName,
                pid: conn.pid,
                peerAddress: conn.peerAddress,
                peerPort: conn.peerPort,
                state: conn.state
            });
        });

        const dnsServers = interfaces.map(i => i.dnsServers).flat().filter(d => d);
        const dnsString = JSON.stringify(dnsServers.sort());
        
        if (currentDNS.length === 0) {
            currentDNS = dnsServers;
        } else {
            const currentDNSString = JSON.stringify(currentDNS.sort());
            if (dnsString !== currentDNSString) {
                io.emit('alert', { type: 'DNS Change', message: `DNS changed to: ${dnsServers.join(', ')}` });
                currentDNS = dnsServers;
            }
        }

        initialized = true;
        return { rx_sec: Math.max(0, rx_sec), tx_sec: Math.max(0, tx_sec), connections: uniqueConnections };
    } catch (error) {
        return null;
    }
}

setInterval(async () => {
    const data = await getNetworkData();
    if (data) io.emit('update', data);
}, 2000);

let serverPort = 0;

// Listen on a random available port internally
server.listen(0, () => {
    serverPort = server.address().port;
    console.log(`Internal server running on port ${serverPort}`);
    if (app.isReady()) {
        createWindow(serverPort);
    }
});

// --- Electron Logic ---
function createWindow(port) {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Network Monitor",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.loadURL(`http://localhost:${port}`);
}

app.whenReady().then(() => {
    if (serverPort !== 0) {
        createWindow(serverPort);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
