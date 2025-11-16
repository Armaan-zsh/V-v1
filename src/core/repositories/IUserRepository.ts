/**
 * User repository interface - defines contract for user data access
 * Pure interface, no implementation details
 */

import { User, UserId } from '../entities/User';

/**
 * Search filters for finding users
 */
export interface UserSearchFilters {
  interests?: string[];
  hasItems?: boolean;
  minStreakDays?: number;
  maxStreakDays?: number;
  profileVisibility?: 'PUBLIC' | 'UNLISTED';
}

/**
 * Pagination options for user queries
 */
export interface UserPaginationOptions {
  limit: number;
  cursor?: string;
}

/**
 * User repository interface
 * Implements repository pattern to abstract data access
 */
export interface IUserRepository {
  /**
   * Create a new user
   * @param user User entity to create
   * @returns Promise that resolves when creation is complete
   * @throws ConflictError if username/email/phone already exists
   */
  create(user: User): Promise<void>;

  /**
   * Find user by ID
   * @param id User ID to search for
   * @returns User if found, null if not found
   */
  findById(id: UserId): Promise<User | null>;

  /**
   * Find user by username (case-insensitive)
   * @param username Username to search for
   * @returns User if found, null if not found
   */
  findByUsername(username: string): Promise<User | null>;

  /**
   * Find user by email
   * @param email Email to search for
   * @returns User if found, null if not found
   */
  findByEmail(email: string): Promise<User | null>;

  /**
   * Find user by phone number
   * @param phone Phone number to search for
   * @returns User if found, null if not found
   */
  findByPhone(phone: string): Promise<User | null>;

  /**
   * Find user by OAuth provider account
   * @param provider Provider name (e.g., 'google', 'apple')
   * @param providerAccountId Provider-specific account ID
   * @returns User if found, null if not found
   */
  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null>;

  /**
   * Update user statistics
   * @param userId ID of user to update
   * @param stats Partial stats to update
   * @returns Promise that resolves when update is complete
   * @throws NotFoundError if user doesn't exist
   */
  updateStats(userId: UserId, stats: Partial<{
    totalItems: number;
    booksCount: number;
    papersCount: number;
    articlesCount: number;
    streakDays: number;
    lastReadDate?: Date;
  }>): Promise<void>;

  /**
   * Update user profile visibility
   * @param userId ID of user to update
   * @param visibility New visibility setting
   * @returns Promise that resolves when update is complete
   * @throws NotFoundError if user doesn't exist
   */
  updateVisibility(userId: UserId, visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'): Promise<void>;

  /**
   * Update user's last login timestamp and login count
   * @param userId ID of user to update
   * @param success Whether login was successful
   * @returns Promise that resolves when update is complete
   */
  recordLogin(userId: UserId, success: boolean): Promise<void>;

  /**
   * Mark user as verified
   * @param userId ID of user to verify
   * @returns Promise that resolves when update is complete
   * @throws NotFoundError if user doesn't exist
   */
  verifyUser(userId: UserId): Promise<void>;

  /**
   * Update user's display name
   * @param userId ID of user to update
   * @param name New display name
   * @returns Promise that resolves when update is complete
   * @throws NotFoundError if user doesn't exist
   */
  updateName(userId: UserId, name: string): Promise<void>;

  /**
   * Get users with public profiles (for discovery)
   * @param options Pagination options
   * @param filters Additional filters
   * @returns Users with pagination info
   */
  findPublicUsers(
    options: UserPaginationOptions,
    filters?: UserSearchFilters
  ): Promise<{
    users: User[];
    nextCursor: string | null;
  }>;

  /**
   * Search users by username or name
   * @param query Search query
   * @param options Pagination options
   * @returns Matching users with pagination info
   */
  searchUsers(
    query: string,
    options: UserPaginationOptions
  ): Promise<{
    users: User[];
    nextCursor: string | null;
  }>;

  /**
   * Generate a unique username based on a base name
   * @param baseName Base name for username generation
   * @returns Unique username string
   */
  generateUniqueUsername(baseName: string): Promise<string>;

  /**
   * Check if a username is available
   * @param username Username to check
   * @returns true if available, false if taken
   */
  isUsernameAvailable(username: string): Promise<boolean>;

  /**
   * Count total number of users
   * @returns Total user count
   */
  count(): Promise<number>;

  /**
   * Count users created in a specific time period
   * @param startDate Start of period
   * @param endDate End of period
   * @returns Count of users in period
   */
  countInPeriod(startDate: Date, endDate: Date): Promise<number>;

  /**
   * Get user IDs for batch processing (e.g., streak updates)
   * @param options Pagination options
   * @returns Batch of user IDs
   */
  getBatchForProcessing(
    options: { limit: number; cursor?: string }
  ): Promise<{
    userIds: UserId[];
    nextCursor: string | null;
  }>;
}

/**
 * Test double for unit testing
 * In-memory implementation for development and testing
 */
export class MockUserRepository implements IUserRepository {
  private users = new Map<string, User>();
  private usernameIndex = new Map<string, UserId>();
  private emailIndex = new Map<string, UserId>();
  private phoneIndex = new Map<string, UserId>();
  private providerIndex = new Map<string, UserId>(); // provider:providerAccountId -> userId

  async create(user: User): Promise<void> {
    // Check for conflicts
    if (this.usernameIndex.has(user.getUsername().toLowerCase())) {
      throw new Error('Username already exists');
    }
    if (user.getEmail() && this.emailIndex.has(user.getEmail()!.toLowerCase())) {
      throw new Error('Email already exists');
    }
    if (user.getPhone() && this.phoneIndex.has(user.getPhone()!)) {
      throw new Error('Phone already exists');
    }

    // Add to storage
    this.users.set(user.getId(), user);
    this.usernameIndex.set(user.getUsername().toLowerCase(), user.getId());
    
    if (user.getEmail()) {
      this.emailIndex.set(user.getEmail()!.toLowerCase(), user.getId());
    }
    if (user.getPhone()) {
      this.phoneIndex.set(user.getPhone()!, user.getId());
    }
  }

  async findById(id: UserId): Promise<User | null> {
    // Simulate realistic latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5));
    return this.users.get(id) || null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const userId = this.usernameIndex.get(username.toLowerCase());
    return userId ? this.users.get(userId) || null : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const userId = this.emailIndex.get(email.toLowerCase());
    return userId ? this.users.get(userId) || null : null;
  }

  async findByPhone(phone: string): Promise<User | null> {
    const userId = this.phoneIndex.get(phone);
    return userId ? this.users.get(userId) || null : null;
  }

  async findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    const key = `${provider}:${providerAccountId}`;
    const userId = this.providerIndex.get(key);
    return userId ? this.users.get(userId) || null : null;
  }

  async updateStats(userId: UserId, stats: any): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    
    // Update stats (simplified for mock)
    const updatedUser = user; // In real implementation, would apply updates
    this.users.set(userId, updatedUser);
  }

  async updateVisibility(userId: UserId, visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    
    // In real implementation, would update the user
    // For now, just return success
  }

  async recordLogin(userId: UserId, success: boolean): Promise<void> {
    // Mock implementation
  }

  async verifyUser(userId: UserId): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    
    // Mock implementation
  }

  async updateName(userId: UserId, name: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    
    // Mock implementation
  }

  async findPublicUsers(options: UserPaginationOptions, filters?: UserSearchFilters): Promise<{
    users: User[];
    nextCursor: string | null;
  }> {
    // Mock implementation
    return { users: [], nextCursor: null };
  }

  async searchUsers(query: string, options: UserPaginationOptions): Promise<{
    users: User[];
    nextCursor: string | null;
  }> {
    // Mock implementation
    return { users: [], nextCursor: null };
  }

  async generateUniqueUsername(baseName: string): Promise<string> {
    // Mock implementation - return base name with random number
    return `${baseName}${Math.floor(Math.random() * 1000)}`;
  }

  async isUsernameAvailable(username: string): Promise<boolean> {
    return !this.usernameIndex.has(username.toLowerCase());
  }

  async count(): Promise<number> {
    return this.users.size;
  }

  async countInPeriod(startDate: Date, endDate: Date): Promise<number> {
    // Mock implementation
    return 0;
  }

  async getBatchForProcessing(options: { limit: number; cursor?: string; }): Promise<{
    userIds: UserId[];
    nextCursor: string | null;
  }> {
    // Mock implementation
    return { userIds: [], nextCursor: null };
  }
}
