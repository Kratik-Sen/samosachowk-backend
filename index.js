const express = require('express');
const http = require('http');
const dns = require('dns');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { createRealtimeServer } = require('./realtime');

dotenv.config({ override: true });
dns.setServers([
  '8.8.8.8',
  '1.1.1.1'
])
const app = express();
const server = http.createServer(app);
const io = createRealtimeServer(server);
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const connectDB = require('./config/db');
connectDB();

// Basic route
app.get('/', (req, res) => {
  res.send('SamosaChowk API is running...');
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/production', require('./routes/production'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/products', require('./routes/products'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/config', require('./routes/config'));

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
