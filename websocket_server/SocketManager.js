/* eslint-disable no-console */

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Server as SocketIO } from 'socket.io'
import prometheusMetrics from 'socket.io-prometheus'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import Utils from './Utils.js'
import { createAdapter } from '@socket.io/redis-streams-adapter'
import SocketDataManager from './SocketDataManager.js'

dotenv.config()

export default class SocketManager {

	constructor(server, roomDataManager, storageManager) {
		this.roomDataManager = roomDataManager
		this.storageManager = storageManager
		this.socketDataManager = new SocketDataManager(storageManager)

		this.io = new SocketIO(server, {
			transports: ['websocket'],
			cors: {
				origin: process.env.NEXTCLOUD_URL || 'http://nextcloud.local',
				methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
				credentials: true,
			},
		})

		this.init()
	}

	async init() {
		if (this.shouldUseRedis()) {
			await this.setupRedisStreamsAdapter()
		} else {
			console.log('Using default in-memory adapter')
		}

		this.io.use(this.socketAuthenticateHandler.bind(this))
		prometheusMetrics(this.io)
		this.io.on('connection', this.handleConnection.bind(this))
	}

	shouldUseRedis() {
		return this.storageManager.strategy.constructor.name === 'RedisStrategy'
	}

	async setupRedisStreamsAdapter() {
		console.log('Setting up Redis Streams adapter')
		try {
			const redisClient = this.storageManager.strategy.client
			this.io.adapter(createAdapter(redisClient, {
				maxLen: 10000,
			}))

			console.log('Redis Streams adapter set up successfully')
		} catch (error) {
			console.error('Failed to set up Redis Streams adapter:', error)
			console.log('Falling back to in-memory adapter')
		}
	}

	async socketAuthenticateHandler(socket, next) {
		try {
			const { token } = socket.handshake.auth
			if (!token) throw new Error('No token provided')

			const decodedData = await this.verifyToken(token)
			await this.socketDataManager.setSocketData(socket.id, decodedData)

			console.log(`[${decodedData.fileId}] User ${decodedData.user.id} with permission ${decodedData.permissions} connected`)

			if (decodedData.permissions === 1) {
				socket.emit('read-only')
			}
			next()
		} catch (error) {
			console.error(error.message)
			next(new Error('Authentication error'))
		}
	}

	handleConnection(socket) {
		socket.emit('init-room')
		socket.on('join-room', (roomID) => this.joinRoomHandler(socket, roomID))
		socket.on('server-broadcast', (roomID, encryptedData, iv) => this.serverBroadcastHandler(socket, roomID, encryptedData, iv))
		socket.on('server-volatile-broadcast', (roomID, encryptedData) => this.serverVolatileBroadcastHandler(socket, roomID, encryptedData))
		socket.on('disconnecting', () => this.disconnectingHandler(socket))
		socket.on('disconnect', () => this.handleDisconnect(socket))
	}

	async handleDisconnect(socket) {
		await this.socketDataManager.deleteSocketData(socket.id)
		socket.removeAllListeners()
	}

	async verifyToken(token) {
		const cachedToken = await this.socketDataManager.getCachedToken(token)
		if (cachedToken) return cachedToken

		return new Promise((resolve, reject) => {
			jwt.verify(token, process.env.JWT_SECRET_KEY, async (err, decoded) => {
				if (err) {
					console.log(err.name === 'TokenExpiredError' ? 'Token expired' : 'Token verification failed')
					return reject(new Error('Authentication error'))
				}
				await this.socketDataManager.setCachedToken(token, decoded)
				resolve(decoded)
			})
		})
	}

	async isSocketReadOnly(socketId) {
		const socketData = await this.socketDataManager.getSocketData(socketId)
		return socketData ? socketData.permissions === 1 : false
	}

	async joinRoomHandler(socket, roomID) {
		console.log(`[${roomID}] ${socket.id} has joined ${roomID}`)
		await socket.join(roomID)

		const userSockets = await this.getUserSockets(roomID)
		const userIds = await Promise.all(userSockets.map(async s => {
			const data = await this.socketDataManager.getSocketData(s.socketId)
			return data.user.id
		}))

		const socketData = await this.socketDataManager.getSocketData(socket.id)
		const room = await this.roomDataManager.syncRoomData(roomID, null, userIds, null, socketData.token)

		if (room) {
			socket.emit('joined-data', Utils.convertStringToArrayBuffer(JSON.stringify(room.data)), [])

			const otherUserSockets = await this.getOtherUserSockets(roomID, socket.id)
			this.io.in(roomID).emit('room-user-change', otherUserSockets)
		} else {
			socket.emit('room-not-found')
		}
	}

	async serverBroadcastHandler(socket, roomID, encryptedData, iv) {
		const isReadOnly = await this.isSocketReadOnly(socket.id)
		if (!socket.rooms.has(roomID) || isReadOnly) return

		socket.broadcast.to(roomID).emit('client-broadcast', encryptedData, iv)

		const decryptedData = JSON.parse(Utils.convertArrayBufferToString(encryptedData))
		const socketData = await this.socketDataManager.getSocketData(socket.id)
		const userId = socketData.user.id
		const userSockets = await this.getUserSockets(roomID)
		const userIds = await Promise.all(userSockets.map(async s => {
			const data = await this.socketDataManager.getSocketData(s.socketId)
			return data.user.id
		}))

		await this.roomDataManager.syncRoomData(roomID, decryptedData.payload.elements, userIds, userId)
	}

	async serverVolatileBroadcastHandler(socket, roomID, encryptedData) {
		const payload = JSON.parse(Utils.convertArrayBufferToString(encryptedData))

		if (payload.type === 'MOUSE_LOCATION') {
			const socketData = await this.socketDataManager.getSocketData(socket.id)
			const eventData = {
				type: 'MOUSE_LOCATION',
				payload: {
					...payload.payload,
					user: socketData.user,
				},
			}

			socket.volatile.broadcast.to(roomID).emit('client-broadcast', Utils.convertStringToArrayBuffer(JSON.stringify(eventData)))
		}
	}

	async disconnectingHandler(socket) {
		const socketData = await this.socketDataManager.getSocketData(socket.id)
		console.log(`[${socketData.fileId}] ${socketData.user.name} has disconnected`)
		for (const roomID of socket.rooms) {
			if (roomID === socket.id) continue
			console.log(`[${roomID}] ${socketData.user.name} has left ${roomID}`)

			const otherUserSockets = await this.getOtherUserSockets(roomID, socket.id)

			if (otherUserSockets.length > 0) {
				socket.broadcast.to(roomID).emit('room-user-change', otherUserSockets)
			}

			const userSockets = await this.getUserSockets(roomID)
			const userIds = await Promise.all(userSockets.map(async s => {
				const data = await this.socketDataManager.getSocketData(s.socketId)
				return data.user.id
			}))

			await this.roomDataManager.syncRoomData(roomID, null, userIds)
		}
	}

	async getUserSockets(roomID) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return Promise.all(sockets.map(async s => {
			const data = await this.socketDataManager.getSocketData(s.id)
			return {
				socketId: s.id,
				user: data.user,
			}
		}))
	}

	async getOtherUserSockets(roomID, currentSocketId) {
		const sockets = await this.io.in(roomID).fetchSockets()
		return Promise.all(sockets
			.filter(s => s.id !== currentSocketId)
			.map(async s => {
				const data = await this.socketDataManager.getSocketData(s.id)
				return {
					socketId: s.id,
					user: data.user,
				}
			}))
	}

}