const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const si = require('systeminformation');
const open = require('open');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
let knownApps = new Set();
let knownHosts = new Set();
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

        // Calculate Speed
        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000; // seconds
        
        let totalRx = 0;
        let totalTx = 0;

        // Sum up all interfaces
        stats.forEach(iface => {
            totalRx += iface.rx_bytes;
            totalTx += iface.tx_bytes;
        });

        // Avoid huge spike on first run
        if (lastRx === 0) {
            lastRx = totalRx;
            lastTx = totalTx;
        }

        const rx_sec = (totalRx - lastRx) / timeDiff;
        const tx_sec = (totalTx - lastTx) / timeDiff;

        lastRx = totalRx;
        lastTx = totalTx;
        lastTime = now;

        // Process Connections & Alerts
        const activeConnections = connections.filter(c => c.state === 'ESTABLISHED');
        const uniqueConnections = [];
        
        activeConnections.forEach(conn => {
            const appName = conn.process || 'Unknown';
            const remoteIP = conn.peerAddress;

            // Alert: New App
            if (appName !== 'Unknown') {
                if (initialized) {
                    if (!knownApps.has(appName)) {
                        knownApps.add(appName);
                        io.emit('alert', { type: 'New App', message: `First network activity detected for: ${appName}` });
                    }
                } else {
                    knownApps.add(appName);
                }
            }

            // Alert: New Host (basic filtering for local IPs)
            if (remoteIP && !remoteIP.startsWith('127.') && !remoteIP.startsWith('192.168.') && !remoteIP.startsWith('10.')) {
                if (initialized) {
                    if (!knownHosts.has(remoteIP)) {
                        knownHosts.add(remoteIP);
                        // Optional: io.emit('alert', { ... });
                    }
                } else {
                    knownHosts.add(remoteIP);
                }
            }

            uniqueConnections.push({
                processName: appName,
                pid: conn.pid,
                peerAddress: remoteIP,
                peerPort: conn.peerPort,
                state: conn.state
            });
        });

        // Alert: DNS Change
        const dnsServers = interfaces.map(i => i.dnsServers).flat().filter(d => d);
        const dnsString = JSON.stringify(dnsServers.sort());
        
        if (currentDNS.length === 0) {
            currentDNS = dnsServers;
        } else {
            const currentDNSString = JSON.stringify(currentDNS.sort());
            if (dnsString !== currentDNSString) {
                io.emit('alert', { type: 'DNS Change', message: `DNS Servers changed to: ${dnsServers.join(', ')}` });
                currentDNS = dnsServers;
            }
        }

        initialized = true;

        return {
            rx_sec: Math.max(0, rx_sec), // prevent negative on counter reset
            tx_sec: Math.max(0, tx_sec),
            connections: uniqueConnections
        };

    } catch (error) {
        console.error('Error fetching stats:', error);
        return null;
    }
}

// Polling Loop
setInterval(async () => {
    const data = await getNetworkData();
    if (data) {
        io.emit('update', data);
    }
}, 2000);

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    open(`http://localhost:${PORT}`);
});
