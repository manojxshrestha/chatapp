const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('redis');
const rateLimit = require('express-rate-limit');

// Create Redis client with fallback for development
let redisClient = null;
let useRedis = false;

async function initRedis() {
    try {
        redisClient = Redis.createClient();
        await redisClient.connect();
        useRedis = true;
        console.log('Redis connected successfully');
    } catch (err) {
        console.log('Redis not available, running without persistence');
        useRedis = false;
    }
}

initRedis();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Rate limiting middleware
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);
app.use(express.static('public'));

// Store active users and their temporary profiles
const activeUsers = new Map();
const userProfiles = new Map();
const userReports = new Map(); // Fallback for when Redis is not available

io.on('connection', (socket) => {
    console.log('A user connected');
    let username = '';

    // Handle user joining
    socket.on('joinChat', async (data) => {
        username = data.username || `User${Math.floor(Math.random() * 1000)}`;
        socket.username = username;
        activeUsers.set(socket.id, { username, socket });
        io.emit('message', `${username} joined the chat!`);
    });

    // Handle dating profile creation
    socket.on('createProfile', async (profile) => {
        userProfiles.set(socket.id, {
            ...profile,
            username: socket.username
        });
        socket.emit('profileCreated', { success: true });
        
        // Try to find matches
        findMatches(socket);
    });

    // Handle chat messages
    socket.on('chatMessage', (msg) => {
        // Rate limit messages (1 message per second)
        const now = Date.now();
        const lastMsg = socket.lastMessage || 0;
        if (now - lastMsg < 1000) {
            return;
        }
        socket.lastMessage = now;

        io.emit('message', `${socket.username}: ${msg}`);
    });

    // Handle private messages
    socket.on('privateMessage', ({ to, message }) => {
        const recipient = Array.from(activeUsers.values())
            .find(user => user.username === to);
        
        if (recipient) {
            recipient.socket.emit('privateMessage', {
                from: socket.username,
                message
            });
        }
    });

    // WebRTC signaling
    socket.on('offer', ({ to, offer }) => {
        const recipient = Array.from(activeUsers.values())
            .find(user => user.username === to);
        
        if (recipient) {
            recipient.socket.emit('offer', {
                from: socket.username,
                offer
            });
        }
    });

    socket.on('answer', ({ to, answer }) => {
        const recipient = Array.from(activeUsers.values())
            .find(user => user.username === to);
        
        if (recipient) {
            recipient.socket.emit('answer', {
                from: socket.username,
                answer
            });
        }
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
        const recipient = Array.from(activeUsers.values())
            .find(user => user.username === to);
        
        if (recipient) {
            recipient.socket.emit('ice-candidate', {
                from: socket.username,
                candidate
            });
        }
    });

    // Handle user reports
    socket.on('reportUser', async ({ reportedUser, reason }) => {
        const reported = Array.from(activeUsers.values())
            .find(user => user.username === reportedUser);
        
        if (reported) {
            if (useRedis) {
                // Store report in Redis with 24h expiry
                await redisClient.setEx(
                    `report:${reported.socket.id}`,
                    86400,
                    JSON.stringify({ reporter: socket.username, reason, timestamp: Date.now() })
                );
                
                // Check if user has multiple reports
                const reports = await redisClient.keys(`report:${reported.socket.id}`);
                if (reports.length >= 3) {
                    // Temporarily ban user
                    reported.socket.emit('banned', { duration: '24h' });
                    reported.socket.disconnect();
                }
            } else {
                // Fallback to in-memory storage
                if (!userReports.has(reported.socket.id)) {
                    userReports.set(reported.socket.id, []);
                }
                userReports.get(reported.socket.id).push({
                    reporter: socket.username,
                    reason,
                    timestamp: Date.now()
                });

                // Check if user has multiple reports
                const reports = userReports.get(reported.socket.id);
                if (reports.length >= 3) {
                    reported.socket.emit('banned', { duration: '24h' });
                    reported.socket.disconnect();
                }
            }
        }
    });

    // Handle user disconnect
    socket.on('disconnect', () => {
        if (username) {
            io.emit('message', `${username} left the chat.`);
            activeUsers.delete(socket.id);
            userProfiles.delete(socket.id);
        }
    });
});

// Function to find matches based on interests
function findMatches(socket) {
    const userProfile = userProfiles.get(socket.id);
    if (!userProfile) return;

    for (const [id, profile] of userProfiles) {
        if (id === socket.id) continue;

        // Check for matching interests
        const matchingInterests = userProfile.interests.filter(
            interest => profile.interests.includes(interest)
        );

        if (matchingInterests.length >= 2) {
            // Notify both users of the match
            socket.emit('match', {
                username: profile.username,
                matchingInterests
            });

            const matchedSocket = activeUsers.get(id).socket;
            matchedSocket.emit('match', {
                username: userProfile.username,
                matchingInterests
            });
        }
    }
}

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

