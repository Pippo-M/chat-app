const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())

const httpServer = http.createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

// ── Đường dẫn file lưu tin nhắn ──
const MSG_FILE = path.join(__dirname, 'data', 'messages.json')

// ── Đọc / ghi JSON ──
function readMessages() {
  try {
    return JSON.parse(fs.readFileSync(MSG_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function saveMessage(roomId, msgObj) {
  const data = readMessages()
  if (!data[roomId]) data[roomId] = []
  data[roomId].push(msgObj)
  // Giữ tối đa 200 tin/room để file không phình to
  if (data[roomId].length > 200) data[roomId] = data[roomId].slice(-200)
  fs.writeFileSync(MSG_FILE, JSON.stringify(data, null, 2))
}

// ── Tạo roomId duy nhất cho 2 người (không phụ thuộc thứ tự) ──
function privateRoomId(userA, userB) {
  return [userA, userB].sort().join('__')
}

// ── Lưu user đang online: { socketId → username } ──
const onlineUsers = {}

io.on('connection', (socket) => {
  console.log(`✅ Kết nối: ${socket.id}`)

  // ── 1. User vào app ──
  socket.on('user:join', (username) => {
    onlineUsers[socket.id] = username
    console.log(`👤 ${username} online`)
    // Báo danh sách online cho tất cả
    io.emit('user:list', Object.values(onlineUsers))
  })

  // ── 2. Gửi tin nhắn group (N:N) ──
  socket.on('message:send', (data) => {
    const msg = {
      from: data.from,
      text: data.text,
      time: new Date().toLocaleTimeString('vi-VN'),
      ts: Date.now()
    }
    // Lưu vào room đặc biệt tên "group"
    saveMessage('group', msg)
    io.emit('message:receive', msg)
  })

  // ── 3. Mở chat 1:1 với ai đó ──
  socket.on('private:join', ({ myName, targetName }) => {
    const roomId = privateRoomId(myName, targetName)
    socket.join(roomId) // Socket.IO join room
    console.log(`🔒 ${myName} mở chat riêng với ${targetName} (room: ${roomId})`)

    // Trả lịch sử tin nhắn của room này
    const history = readMessages()[roomId] || []
    socket.emit('private:history', { roomId, history })
  })

  // ── 4. Gửi tin nhắn 1:1 ──
  socket.on('private:message', ({ from, to, text }) => {
    const roomId = privateRoomId(from, to)
    const msg = {
      from,
      to,
      text,
      time: new Date().toLocaleTimeString('vi-VN'),
      ts: Date.now()
    }
    saveMessage(roomId, msg)

    // Gửi cho cả 2 người trong room
    // Nhưng "to" có thể chưa join room → tìm socket của họ và join
    const targetSocketId = Object.keys(onlineUsers).find(
      id => onlineUsers[id] === to
    )
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId)
      if (targetSocket) targetSocket.join(roomId)
    }

    io.to(roomId).emit('private:receive', { roomId, msg })
    console.log(`💬 [${roomId}] ${from} → ${to}: ${text}`)
  })

  // ── 5. Ngắt kết nối ──
  socket.on('disconnect', () => {
    const username = onlineUsers[socket.id]
    delete onlineUsers[socket.id]
    if (username) {
      console.log(`❌ ${username} offline`)
      io.emit('user:list', Object.values(onlineUsers))
    }
  })
})

// ── REST: Lấy lịch sử group (load khi vào app) ──
app.get('/history/group', (req, res) => {
  const data = readMessages()
  res.json(data['group'] || [])
})

httpServer.listen(3001, () => {
  console.log('🚀 Server: http://localhost:3001')
})
