import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import pino from 'pino';
import { z } from 'zod';

// Types for WebSocket system
export interface SocketUser {
  userId: string;
  socketId: string;
  connectedAt: Date;
  lastActivity: Date;
  rooms: Set<string>;
  metadata?: {
    username?: string;
    avatar?: string;
    status?: 'online' | 'away' | 'busy';
  };
}

export interface SocketMessage {
  type: 'join_room' | 'leave_room' | 'message' | 'presence' | 'typing' | 'search_sync' | 'activity';
  payload: any;
  timestamp: Date;
  userId: string;
  roomId?: string;
}

export interface Room {
  id: string;
  type: 'user' | 'group' | 'global';
  members: Set<string>;
  createdAt: Date;
  metadata?: {
    name?: string;
    description?: string;
    privacy?: 'public' | 'private';
    maxMembers?: number;
  };
}

export interface WebSocketConfig {
  port: number;
  maxConnections: number;
  heartbeatInterval: number;
  messageQueueSize: number;
  rateLimit: {
    windowMs: number;
    maxMessages: number;
  };
}

// Validation schemas
export const SocketMessageSchema = z.object({
  type: z.enum(['join_room', 'leave_room', 'message', 'presence', 'typing', 'search_sync', 'activity']),
  payload: z.any(),
  timestamp: z.date(),
  userId: z.string(),
  roomId: z.string().optional(),
});

export class WebSocketServerManager {
  private wss: WebSocketServer | null = null;
  private server: Server | null = null;
  private logger: pino.Logger;
  private users: Map<string, SocketUser> = new Map();
  private rooms: Map<string, Room> = new Map();
  private messageQueues: Map<string, any[]> = new Map();
  private rateLimiters: Map<string, { count: number; resetTime: number }> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private config: WebSocketConfig;

  constructor(config: Partial<WebSocketConfig> = {}) {
    this.config = {
      port: 8080,
      maxConnections: 1000,
      heartbeatInterval: 30000, // 30 seconds
      messageQueueSize: 100,
      rateLimit: {
        windowMs: 60000, // 1 minute
        maxMessages: 30,
      },
      ...config,
    };

    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });
  }

  /**
   * Start the WebSocket server
   */
  async start(server?: Server): Promise<void> {
    try {
      if (server) {
        this.server = server;
        this.wss = new WebSocketServer({ server, path: '/ws' });
      } else {
        this.wss = new WebSocketServer({ port: this.config.port });
      }

      this.setupEventHandlers();
      this.startHeartbeat();

      this.logger.info('WebSocket server started', { 
        port: this.config.port,
        path: '/ws'
      });

    } catch (error) {
      this.logger.error('Failed to start WebSocket server', { error });
      throw error;
    }
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    try {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      // Close all connections
      for (const [userId, user] of this.users) {
        this.disconnectUser(userId, 'Server shutdown');
      }

      if (this.wss) {
        await new Promise<void>((resolve) => {
          this.wss!.close(() => resolve());
        });
      }

      this.logger.info('WebSocket server stopped');
    } catch (error) {
      this.logger.error('Error stopping WebSocket server', { error });
      throw error;
    }
  }

  /**
   * Set up event handlers for WebSocket connections
   */
  private setupEventHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      this.logger.error('WebSocket server error', { error });
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: any): void {
    const socketId = this.generateSocketId();
    const userAgent = req.headers['user-agent'];
    
    this.logger.info('New WebSocket connection', { 
      socketId, 
      userAgent 
    });

    // Rate limiting check
    const ip = req.socket.remoteAddress;
    if (!this.checkRateLimit(ip)) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    // Store connection
    const user: SocketUser = {
      userId: `anonymous_${socketId}`, // Will be updated when authenticated
      socketId,
      connectedAt: new Date(),
      lastActivity: new Date(),
      rooms: new Set(),
    };

    this.users.set(socketId, user);
    this.setupClientHandlers(ws, socketId);

    // Send welcome message
    this.sendToSocket(ws, {
      type: 'connection_established',
      payload: {
        socketId,
        serverTime: new Date().toISOString(),
        capabilities: ['realtime', 'presence', 'typing', 'search_sync'],
      },
    });

    // Clean up on close
    ws.on('close', () => {
      this.disconnectUser(socketId, 'Client disconnected');
    });

    ws.on('error', (error) => {
      this.logger.error('WebSocket client error', { socketId, error });
      this.disconnectUser(socketId, 'Connection error');
    });
  }

  /**
   * Set up handlers for client messages
   */
  private setupClientHandlers(ws: WebSocket, socketId: string): void {
    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(ws, socketId, message);
      } catch (error) {
        this.logger.error('Invalid message format', { socketId, error });
        this.sendError(ws, 'Invalid message format');
      }
    });

    // Ping-pong for connection health
    ws.on('pong', () => {
      const user = this.users.get(socketId);
      if (user) {
        user.lastActivity = new Date();
      }
    });
  }

  /**
   * Handle incoming messages from clients
   */
  private async handleMessage(ws: WebSocket, socketId: string, message: any): Promise<void> {
    const user = this.users.get(socketId);
    if (!user) return;

    // Rate limiting
    if (!this.checkRateLimit(socketId)) {
      this.sendError(ws, 'Rate limit exceeded');
      return;
    }

    // Update last activity
    user.lastActivity = new Date();

    // Update rate limiter
    this.updateRateLimit(socketId);

    try {
      // Validate message structure
      const validatedMessage = SocketMessageSchema.parse({
        ...message,
        timestamp: new Date(message.timestamp),
      });

      // Route message based on type
      switch (validatedMessage.type) {
        case 'join_room':
          await this.handleJoinRoom(ws, user, validatedMessage.payload);
          break;
        case 'leave_room':
          await this.handleLeaveRoom(ws, user, validatedMessage.payload);
          break;
        case 'message':
          await this.handleChatMessage(user, validatedMessage);
          break;
        case 'presence':
          await this.handlePresenceUpdate(user, validatedMessage.payload);
          break;
        case 'typing':
          await this.handleTypingIndicator(user, validatedMessage.payload);
          break;
        case 'search_sync':
          await this.handleSearchSync(user, validatedMessage.payload);
          break;
        case 'activity':
          await this.handleActivityBroadcast(user, validatedMessage.payload);
          break;
        default:
          this.sendError(ws, `Unknown message type: ${validatedMessage.type}`);
      }

    } catch (error) {
      this.logger.error('Message handling error', { socketId, message, error });
      this.sendError(ws, 'Message processing failed');
    }
  }

  /**
   * Handle room joining
   */
  private async handleJoinRoom(ws: WebSocket, user: SocketUser, payload: any): Promise<void> {
    const { roomId, userId, metadata } = payload;

    if (!roomId || !userId) {
      this.sendError(ws, 'Room ID and User ID required');
      return;
    }

    // Update user identity
    user.userId = userId;
    if (metadata) {
      user.metadata = metadata;
    }

    // Join room
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        id: roomId,
        type: 'group',
        members: new Set(),
        createdAt: new Date(),
      });
    }

    const room = this.rooms.get(roomId)!;
    
    if (room.members.size >= (room.metadata?.maxMembers || 100)) {
      this.sendError(ws, 'Room is full');
      return;
    }

    room.members.add(userId);
    user.rooms.add(roomId);

    // Send confirmation
    this.sendToSocket(ws, {
      type: 'room_joined',
      payload: { roomId },
    });

    // Broadcast to room members
    this.broadcastToRoom(roomId, {
      type: 'user_joined',
      payload: {
        userId,
        user: user.metadata,
        timestamp: new Date(),
      },
    }, userId); // Exclude sender

    this.logger.info('User joined room', { userId, roomId });
  }

  /**
   * Handle room leaving
   */
  private async handleLeaveRoom(ws: WebSocket, user: SocketUser, payload: any): Promise<void> {
    const { roomId } = payload;

    if (!roomId) {
      this.sendError(ws, 'Room ID required');
      return;
    }

    // Leave room
    user.rooms.delete(roomId);
    
    const room = this.rooms.get(roomId);
    if (room) {
      room.members.delete(user.userId);
      
      // Clean up empty rooms
      if (room.members.size === 0) {
        this.rooms.delete(roomId);
      }
    }

    // Send confirmation
    this.sendToSocket(ws, {
      type: 'room_left',
      payload: { roomId },
    });

    // Broadcast to room members
    this.broadcastToRoom(roomId, {
      type: 'user_left',
      payload: {
        userId: user.userId,
        timestamp: new Date(),
      },
    });

    this.logger.info('User left room', { userId: user.userId, roomId });
  }

  /**
   * Handle chat messages
   */
  private async handleChatMessage(user: SocketUser, message: any): Promise<void> {
    const { roomId, content, messageType = 'text' } = message.payload;

    if (!roomId || !content) {
      return;
    }

    const chatMessage = {
      id: this.generateMessageId(),
      type: 'message',
      payload: {
        content,
        messageType,
        userId: user.userId,
        user: user.metadata,
        timestamp: new Date(),
      },
    };

    // Broadcast to room
    this.broadcastToRoom(roomId, chatMessage);

    // Queue message for persistence
    this.queueMessage(roomId, chatMessage);
  }

  /**
   * Handle presence updates
   */
  private async handlePresenceUpdate(user: SocketUser, payload: any): Promise<void> {
    const { status, roomId } = payload;

    user.metadata = {
      ...user.metadata,
      status,
    };

    // Broadcast presence to user's rooms
    for (const room of user.rooms) {
      if (!roomId || room === roomId) {
        this.broadcastToRoom(room, {
          type: 'presence_update',
          payload: {
            userId: user.userId,
            status,
            timestamp: new Date(),
          },
        });
      }
    }
  }

  /**
   * Handle typing indicators
   */
  private async handleTypingIndicator(user: SocketUser, payload: any): Promise<void> {
    const { roomId, isTyping } = payload;

    if (!roomId) return;

    // Broadcast typing indicator to room (except sender)
    this.broadcastToRoom(roomId, {
      type: 'typing_indicator',
      payload: {
        userId: user.userId,
        user: user.metadata,
        isTyping,
        timestamp: new Date(),
      },
    }, user.userId);

    // Auto-stop typing after 5 seconds
    if (isTyping) {
      setTimeout(() => {
        this.broadcastToRoom(roomId, {
          type: 'typing_indicator',
          payload: {
            userId: user.userId,
            isTyping: false,
            timestamp: new Date(),
          },
        }, user.userId);
      }, 5000);
    }
  }

  /**
   * Handle search synchronization
   */
  private async handleSearchSync(user: SocketUser, payload: any): Promise<void> {
    const { query, results, roomId } = payload;

    // Broadcast search results to room
    if (roomId) {
      this.broadcastToRoom(roomId, {
        type: 'search_sync',
        payload: {
          userId: user.userId,
          query,
          resultsCount: results?.length || 0,
          timestamp: new Date(),
        },
      }, user.userId);
    }
  }

  /**
   * Handle activity broadcasts
   */
  private async handleActivityBroadcast(user: SocketUser, payload: any): Promise<void> {
    const { activityType, data, roomId, audience = 'room' } = payload;

    const activity = {
      type: 'activity',
      payload: {
        userId: user.userId,
        user: user.metadata,
        activityType,
        data,
        timestamp: new Date(),
      },
    };

    if (audience === 'room' && roomId) {
      this.broadcastToRoom(roomId, activity);
    } else if (audience === 'global') {
      this.broadcastToAll(activity);
    }
  }

  /**
   * Broadcast message to all users in a room
   */
  private broadcastToRoom(roomId: string, message: any, excludeUserId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [socketId, user] of this.users) {
      if (user.rooms.has(roomId) && user.userId !== excludeUserId) {
        this.sendToUser(user.userId, message);
      }
    }
  }

  /**
   * Broadcast message to all connected users
   */
  private broadcastToAll(message: any): void {
    for (const user of this.users.values()) {
      this.sendToUser(user.userId, message);
    }
  }

  /**
   * Send message to specific user
   */
  private sendToUser(userId: string, message: any): void {
    for (const user of this.users.values()) {
      if (user.userId === userId) {
        this.sendToSocketByUser(user, message);
        break;
      }
    }
  }

  /**
   * Send message to specific socket
   */
  private sendToSocket(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send message to user's socket
   */
  private sendToSocketByUser(user: SocketUser, message: any): void {
    // In a real implementation, you'd store WebSocket references
    // For now, we'll log the message
    this.logger.debug('Sending message to user', { 
      userId: user.userId, 
      messageType: message.type 
    });
  }

  /**
   * Send error message
   */
  private sendError(ws: WebSocket, error: string): void {
    this.sendToSocket(ws, {
      type: 'error',
      payload: { error, timestamp: new Date() },
    });
  }

  /**
   * Disconnect user
   */
  private disconnectUser(socketId: string, reason: string): void {
    const user = this.users.get(socketId);
    if (!user) return;

    // Leave all rooms
    for (const roomId of user.rooms) {
      this.broadcastToRoom(roomId, {
        type: 'user_left',
        payload: {
          userId: user.userId,
          reason,
          timestamp: new Date(),
        },
      });
    }

    this.users.delete(socketId);
    this.rateLimiters.delete(socketId);

    this.logger.info('User disconnected', { 
      userId: user.userId, 
      socketId, 
      reason 
    });
  }

  /**
   * Start heartbeat to detect dead connections
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [socketId, user] of this.users) {
        const timeSinceActivity = Date.now() - user.lastActivity.getTime();
        
        if (timeSinceActivity > this.config.heartbeatInterval * 2) {
          this.logger.warn('Removing inactive user', { socketId, userId: user.userId });
          this.disconnectUser(socketId, 'Inactive connection');
        }
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Check rate limiting
   */
  private checkRateLimit(identifier: string): boolean {
    const limiter = this.rateLimiters.get(identifier);
    const now = Date.now();

    if (!limiter || now > limiter.resetTime) {
      return true;
    }

    return limiter.count < this.config.rateLimit.maxMessages;
  }

  /**
   * Update rate limiter
   */
  private updateRateLimit(identifier: string): void {
    const now = Date.now();
    let limiter = this.rateLimiters.get(identifier);

    if (!limiter || now > limiter.resetTime) {
      limiter = {
        count: 1,
        resetTime: now + this.config.rateLimit.windowMs,
      };
    } else {
      limiter.count++;
    }

    this.rateLimiters.set(identifier, limiter);
  }

  /**
   * Queue message for persistence
   */
  private queueMessage(roomId: string, message: any): void {
    if (!this.messageQueues.has(roomId)) {
      this.messageQueues.set(roomId, []);
    }

    const queue = this.messageQueues.get(roomId)!;
    queue.push(message);

    // Keep queue size manageable
    if (queue.length > this.config.messageQueueSize) {
      queue.shift();
    }
  }

  /**
   * Generate unique socket ID
   */
  private generateSocketId(): string {
    return `socket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get server statistics
   */
  getStats(): {
    connectedUsers: number;
    activeRooms: number;
    messagesProcessed: number;
    uptime: number;
  } {
    const connectedUsers = this.users.size;
    const activeRooms = this.rooms.size;
    const totalMessages = Array.from(this.messageQueues.values())
      .reduce((sum, queue) => sum + queue.length, 0);

    return {
      connectedUsers,
      activeRooms,
      messagesProcessed: totalMessages,
      uptime: process.uptime(),
    };
  }

  /**
   * Get room information
   */
  getRoomInfo(roomId: string): Room | null {
    return this.rooms.get(roomId) || null;
  }

  /**
   * Get user's rooms
   */
  getUserRooms(userId: string): string[] {
    const rooms: string[] = [];
    
    for (const [socketId, user] of this.users) {
      if (user.userId === userId) {
        return Array.from(user.rooms);
      }
    }
    
    return rooms;
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: any;
  }> {
    const stats = this.getStats();
    
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (stats.connectedUsers > this.config.maxConnections * 0.9) {
      status = 'degraded';
    }
    
    if (stats.connectedUsers > this.config.maxConnections) {
      status = 'unhealthy';
    }

    return {
      status,
      details: {
        ...stats,
        config: {
          maxConnections: this.config.maxConnections,
          heartbeatInterval: this.config.heartbeatInterval,
          rateLimit: this.config.rateLimit,
        },
      },
    };
  }
}