const WebSocket = require('ws');
const si = require('systeminformation');
const util = require('util');
const axios = require('axios');
const chalk = require('chalk');
const pm2 = require('pm2');
const pmx = require('pmx').init(); // Initialize PMX
const { exec } = require('child_process');


const currentProcessId = process.env.pm_id; // PM2 injects environment variables, including pm_id, into its managed processes



let actionQueue = [];
const MAX_QUEUE_SIZE = 10;



const execAsync = util.promisify(require('child_process').exec);

let pm2Connected = false;
let ws;
let sendDataInterval;
let serverURL = '';
let staticSystemInfo = {}; // Object to hold static system info



// PMX and serverURL simulation
// Simulated response from pmx.initModule callback to demonstrate configuration usage.
//let serverURL = 'ws://localhost:3000'; // Default URL, replace with actual configuration if needed




// Helper function to generate timestamps
function timestamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '') + ' Z';
}

// Override console.log to include timestamp
const originalLog = console.log;
console.log = (...args) => {
    originalLog(`[${timestamp()}] -`, ...args);
};

// Override console.error to include timestamp
const originalError = console.error;
console.error = (...args) => {
    originalError(`[${timestamp()}] -`, ...args);
};






pmx.initModule({}, (err, conf) => {
    if (conf.serverURL) {
        console.log("Configuration :");
        console.table(conf);
        serverURL = conf.serverURL;
    } else {
        console.warn(chalk.yellow('Warning: Master Server URL not configured. \n\r' +
            ' Set the master server using `pm2 set pm2-client:serverURL "ws://masterdns.exxample.com:3000"`'));
         console.warn(chalk.yellow('defaulting to ws://localhost:7000'));    
         serverURL =  "ws://localhost:7000";
       // process.exit(1);

    }
});






// PM2 Connection Management
async function initPM2Connection() {
    return new Promise((resolve, reject) => {
        pm2.connect(err => {
            if (err) {
                console.error("PM2 Connection Error:", err);
                pm2Connected = false;
                reject(err);
            } else {
                console.log("PM2 Connected");
                pm2Connected = true;
                resolve();
            }
        });
    });
}

async function ensurePM2Connection() {
    if (!pm2Connected) {
        console.log("PM2 connection lost. Attempting to reconnect...");
        await initPM2Connection().catch(err => {
            console.error("Reconnecting to PM2 failed:", err);
        });
    }
}

function disconnectPM2() {
    if (pm2Connected) {
        pm2.disconnect();
        pm2Connected = false;
        console.log("PM2 Disconnected");
    }
}



async function gatherStaticSystemData() {
    const hostname = await si.osInfo().then(data => data.fqdn);
    const OSInfo = await si.osInfo();
    const virtInfo = await getVirtualization();
    const ipInfo = await getIpInfo();

    // Cache static system info for reuse
    staticSystemInfo = {
        hostname,
        OSInfo,
        virtInfo,
        ipInfo,
    };
}

async function gatherDynamicSystemData() {
    const fileSystemInfo = await si.fsSize();
    const systemLoad = await si.currentLoad();
    const sysMemory = await si.mem();
    const systemTime = new Date().toISOString();
    const pm2_processes = await gatherPM2states(); // Uses PM2 connection

    // Combine static and dynamic system data
    const systemData = {
        ...staticSystemInfo, // Spread static data into the object
        fileSystemInfo,
        systemLoad,
        sysMemory: {
            usedMemory: sysMemory.active,
            totalMemory: sysMemory.total,
            PercentageUsed: ((sysMemory.active / sysMemory.total) * 100).toFixed(2) + "%",
        },
        systemTime,
        pm2_processes,
    };

    return systemData;
}


async function gatherPM2states() {
    // This function now assumes PM2 connection is managed externally
    return new Promise((resolve, reject) => {
        pm2.list((err, list) => {
            if (err) {
                console.error("Error fetching PM2 states:", err);
                pm2Connected = false; // Ensures reconnection attempt on next call
                reject(err);
            } else {
                const processList = list.map(proc => ({
                    name: proc.name,
                    status: proc.pm2_env.status,
                    cpu: proc.monit.cpu,
                    memory: (proc.monit.memory / 1024 / 1024).toFixed(2),
                    restart_time: proc.pm2_env.restart_time,
                    proc: proc,

                }));
                resolve(processList);
            }
        });
    });
}


async function getVirtualization() {
    try {
        const { stdout } = await execAsync('systemd-detect-virt');
        const virtResult = stdout.trim();
        if (virtResult && virtResult !== 'vm-other') {
            return virtResult;
        } else {
            throw new Error("'systemd-detect-virt' returned 'vm-other' or no output");
        }
    } catch (error) {
        const data = await si.system();
        if (data.virtual && data.virtualHost) {
            return data;
        }
        return data.virtual ? 'Virtualized' : 'None';
    }
}

async function getIpInfo() {
    try {
        // External IP information
        const ipResponse = await axios.get('https://ipinfo.io/json');
        const externalIpInfo = ipResponse.data;

        // Local IP information
        const localNetworkInterfaces = await si.networkInterfaces();
        const localIps = localNetworkInterfaces
            .filter(iface => iface.ip4 && iface.ip4.length > 0 && !iface.internal)
            .map(iface => ({
                iface: iface.ifaceName,
                ip4: iface.ip4,
                ip6: iface.ip6 || 'n/a', // Include IPv6 address if available, otherwise mark as 'n/a'
            }));
        console.log("localIps", localIps);
        // Combine external and local IP information
        const combinedIpInfo = {
            ...externalIpInfo, // Spread external IP info into the object
            localIps, // Add local IP information
        };

        return combinedIpInfo;
    } catch (error) {
        console.error(error);
        return 'Failed to retrieve IP info';
    }
}





function connectWebSocket() {
    ws = new WebSocket(serverURL);

    ws.on('open', function open() {
        console.log('Connected to WebSocket server.');

        // Clear any existing interval to avoid duplicate transmissions
        if (sendDataInterval) clearInterval(sendDataInterval);

        // Set up an interval to send updated system data every second
        sendDataInterval = setInterval(async () => {
            const systemData = await gatherDynamicSystemData();
            // console.log (">>>------------------------------------------------------------------------");
            // console.log (systemData);
            // console.log ("<<<------------------------------------------------------------------------");



            systemData.type = 'client-status'; // Example type, adjust as needed

            if (ws.readyState === WebSocket.OPEN) {
                //console.table(systemData);
                ws.send(JSON.stringify(systemData));
            } else {
                console.log('WebSocket is not open. Current state:', ws.readyState);
                // Attempt to reconnect if the WebSocket is not in an open state
                reconnectWebSocket();
            }
        }, 1000); // Adjust interval as needed
    });





    //// Handle responsesfrom server actioions directed to this host 
    //// This is where the magic is hadled..

    // Function to process the action queue

    // Function to execute PM2 commands, assuming a persistent PM2 connection
    function executePM2Command(action, pm2Id) {
        return new Promise((resolve, reject) => {


            // Check if trying to stop the current process
            if (action === 'stop' && pm2Id.toString() === currentProcessId) {
                console.log(`Prevented 'stop' action on self (PM2 ID: ${pm2Id})`);
                return reject(new Error("Cannot stop the current process."));
            }


            switch (action) {
                case 'start':
                case 'stop':
                case 'restart':
                    // Use the existing, persistent PM2 connection
                    pm2[action](pm2Id, (err, proc) => {
                        if (err) reject(err);
                        else resolve(proc);
                    });
                    break;
                case 'reset':
                    // For reset, since it doesn't directly involve a PM2 command, use exec
                    exec(`pm2 reset ${pm2Id}`, (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(stdout || stderr);
                        }
                    });
                    break;
                case 'logs':

                    break;
                default:
                    reject(new Error('Unsupported action'));
            }
        });
    }


    // Function to process the next action in the queue
    function processActionQueue() {
        if (actionQueue.length === 0) return; // If queue is empty, do nothing

        const { actionName, pm2Id } = actionQueue.shift(); // Dequeue the next action

        executePM2Command(actionName, pm2Id)
            .then(() => console.log(`Action ${actionName} for PM2 ID ${pm2Id} completed.`))
            .catch(err => console.error(`Error executing action ${actionName} for PM2 ID ${pm2Id}:`, err))
            .finally(() => {
                // Delay before processing the next action
                if (actionQueue.length > 0) {
                    setTimeout(processActionQueue, 500); // Adjust delay as needed
                }
            });
    }


    // WebSocket message event handler
    ws.on('message', function incoming(data) {
        const response = JSON.parse(data);
        if (response.status == "action" && Array.isArray(response.actions)) {
            console.log('Received actions from server:', response.actions);
            // Append new actions to the queue
            response.actions.forEach(action => {
                if (actionQueue.length < 10) { // Ensure the queue doesn't exceed 10 actions
                    actionQueue.push({ actionName: action.actionName, pm2Id: action.pm2_id });
                } else {
                    console.error('Action queue is full. New actions cannot be added.');
                }
            });

            // If the queue was empty before receiving new actions, start processing
            if (response.actions.length > 0 && actionQueue.length === response.actions.length) {
                processActionQueue();
            }
        }
    });



    ws.on('close', function close() {
        console.log('Disconnected from WebSocket server, attempting to reconnect...');
        clearInterval(sendDataInterval);
        // Reconnect after a delay to avoid flooding attempts
        setTimeout(connectWebSocket, 5000); // Adjust delay as needed
    });

    ws.on('error', function error(err) {
        console.error('WebSocket error:', err);
    });


}













function reconnectWebSocket() {
    if (ws.readyState === WebSocket.CLOSED) {
        connectWebSocket();
    }
}

// Main function to initialize the application
async function initializeApplication() {
    try {
        await initPM2Connection();
        console.log("PM2 connection established.");
        await gatherStaticSystemData(); // Gather static system info at startup

    } catch (error) {
        console.error("Error establishing PM2 connection:", error);
    }

    // Now connect to the WebSocket server
    connectWebSocket();
}

initializeApplication();

// Ensure PM2 disconnection on shutdown
process.on('SIGINT', () => {
    console.log("Shutting down...");
    disconnectPM2();
    if (ws) {
        ws.close();
    }
    process.exit();
});