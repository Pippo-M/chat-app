const express = require('express')
const http    = require('http')
const { Server } = require('socket.io')
const cors    = require('cors')
const fs      = require('fs')
const path    = require('path')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '../client')))

const httpServer = http.createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

// ── File paths ──
const MSG_FILE  = path.join(__dirname, 'data/messages.json')
const USER_FILE = path.join(__dirname, 'data/users.json')

// ════════════════════════════════
// FILE HELPERS
// ════════════════════════════════
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return {} }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}
function saveMessage(roomId, msg) {
  const data = readJSON(MSG_FILE)
  if (!data[roomId]) data[roomId] = []
  data[roomId].push(msg)
  if (data[roomId].length > 200) data[roomId] = data[roomId].slice(-200)
  writeJSON(MSG_FILE, data)
}
function privateRoomId(a, b) { return [a, b].sort().join('__') }

// ════════════════════════════════
// ONLINE USERS  { socketId → { uid, name, photo, role } }
// ════════════════════════════════
const onlineUsers = {}

function broadcastUserList() {
  io.emit('user:list', Object.values(onlineUsers))
}

// ════════════════════════════════
// SOCKET EVENTS
// ════════════════════════════════
io.on('connection', (socket) => {
  console.log(`✅ Connect: ${socket.id}`)

  // ── 1. User vào app ──
  socket.on('user:join', ({ uid, name, photo }) => {
    const db = readJSON(USER_FILE)
    const isFirst = Object.keys(db).length === 0

    // Lần đầu → admin, còn lại → member
    if (!db[uid]) {
      db[uid] = { uid, name, photo, role: isFirst ? 'admin' : 'user' }
      writeJSON(USER_FILE, db)
    } else {
      // Cập nhật name/photo nếu đổi
      db[uid].name  = name
      db[uid].photo = photo
      writeJSON(USER_FILE, db)
    }

    const role = db[uid].role
    onlineUsers[socket.id] = { uid, name, photo, role }
    console.log(`👤 ${name} [${role}] online`)

    // Trả role về cho chính user này
    socket.emit('auth:role', role)
    broadcastUserList()
  })

  // ── 2. Group chat N:N ──
  socket.on('message:send', ({ from, photo, text }) => {
    const msg = { from, photo: photo||'', text, time: new Date().toLocaleTimeString('vi-VN'), ts: Date.now() }
    saveMessage('group', msg)
    io.emit('message:receive', msg)
  })

  // ── 3. Private chat 1:1 ──
  socket.on('private:join', ({ myName, targetName }) => {
    const roomId = privateRoomId(myName, targetName)
    socket.join(roomId)
    const history = readJSON(MSG_FILE)[roomId] || []
    socket.emit('private:history', { roomId, history })
  })

  socket.on('private:message', ({ from, to, photo, text }) => {
    const roomId = privateRoomId(from, to)
    const msg = { from, to, photo: photo||'', text, time: new Date().toLocaleTimeString('vi-VN'), ts: Date.now() }
    saveMessage(roomId, msg)

    // Đảm bảo "to" đã join room
    const targetSid = Object.keys(onlineUsers).find(id => onlineUsers[id].name === to)
    if (targetSid) {
      const tSock = io.sockets.sockets.get(targetSid)
      if (tSock) tSock.join(roomId)
    }
    io.to(roomId).emit('private:receive', { roomId, msg })
    console.log(`💬 [1:1] ${from}→${to}: ${text}`)
  })

  // ── 4. Channel 1:N (#thông-báo) ──
  socket.on('channel:join', () => {
    socket.join('channel')
    const history = readJSON(MSG_FILE)['channel'] || []
    socket.emit('channel:history', history)
  })

  socket.on('channel:message', ({ from, photo, text }) => {
    // Kiểm tra quyền server-side
    const me = onlineUsers[socket.id]
    if (!me || me.role !== 'admin') {
      socket.emit('channel:error', 'Bạn không có quyền gửi tin vào kênh này')
      return
    }
    const msg = { from, photo: photo||'', text, time: new Date().toLocaleTimeString('vi-VN'), ts: Date.now() }
    saveMessage('channel', msg)
    io.to('channel').emit('channel:receive', msg)
    console.log(`📢 [channel] ${from}: ${text}`)
  })

  // ── 5. Admin panel ──
  socket.on('admin:getUsers', () => {
    const me = onlineUsers[socket.id]
    if (!me || me.role !== 'admin') return // Chặn nếu không phải admin
    socket.emit('admin:userList', Object.values(readJSON(USER_FILE)))
  })

  socket.on('admin:setRole', ({ targetUid, newRole }) => {
    const me = onlineUsers[socket.id]
    if (!me || me.role !== 'admin') return

    const db = readJSON(USER_FILE)
    if (!db[targetUid]) return
    db[targetUid].role = newRole
    writeJSON(USER_FILE, db)
    console.log(`🔧 Admin ${me.name} đổi role ${targetUid} → ${newRole}`)

    // Cập nhật lại admin panel
    socket.emit('admin:userList', Object.values(db))

    // Nếu người bị đổi đang online → notify ngay
    const targetSid = Object.keys(onlineUsers).find(id => onlineUsers[id].uid === targetUid)
    if (targetSid) {
      onlineUsers[targetSid].role = newRole
      io.to(targetSid).emit('auth:role', newRole)
    }
    broadcastUserList()
  })

  // ── 6. Disconnect ──
  socket.on('disconnect', () => {
    const u = onlineUsers[socket.id]
    delete onlineUsers[socket.id]
    if (u) { console.log(`❌ ${u.name} offline`); broadcastUserList() }
  })
})

// ── REST endpoints ──
app.get('/history/group',   (_, res) => res.json(readJSON(MSG_FILE)['group']   || []))
app.get('/history/channel', (_, res) => res.json(readJSON(MSG_FILE)['channel'] || []))

httpServer.listen(3001, () => console.log('🚀 Server: http://localhost:3001'))
