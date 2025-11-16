/**
 * Pure TypeScript User entity with zero external dependencies
 * Implements domain-driven design with business logic and validation
 */

// Value object for UserId using newtype pattern
export type UserId = string & { readonly __brand: 'UserId' };

// Create a branded type helper
function brand<T extends string>(value: T): T & { readonly __brand: T } {
  return value as T & { readonly __brand: T };
}

// User statistics type
export interface UserStats {
  readonly totalItems: number;
  readonly booksCount: number;
  readonly papersCount: number;
  readonly articlesCount: number;
  readonly streakDays: number;
  readonly lastReadDate?: Date;
}

// Profile visibility enum
export enum ProfileVisibility {
  PUBLIC = 'PUBLIC',
  UNLISTED = 'UNLISTED',
  PRIVATE = '_PRIVATE'
}

/**
 * User entity representing the core domain object
 * Immutable - only updates via explicit methods
 */
export class User {
  private constructor(
    private readonly id: UserId,
    private readonly username: string,
    private readonly email?: string,
    private readonly phone?: string,
    private readonly name?: string,
    private readonly profileVisibility: ProfileVisibility = ProfileVisibility.PUBLIC,
    private readonly isVerified: boolean = false,
    private readonly stats: UserStats = {
      totalItems: 0,
      booksCount: 0,
      papersCount: 0,
      articlesCount: 0,
      streakDays: 0
    },
    private readonly lastReadDate?: Date,
    private readonly createdAt: Date = new Date(),
    private readonly updatedAt: Date = new Date()
  ) {}

  /**
   * Create a new User instance with validation
   */
  static create(input: {
    id?: string;
    username: string;
    email?: string;
    phone?: string;
    name?: string;
    profileVisibility?: ProfileVisibility;
  }): User {
    // Validate username format
    if (!input.username || input.username.length < 3) {
      throw new Error('Username must be at least 3 characters long');
    }
    
    if (input.username.length > 39) {
      throw new Error('Username cannot exceed 39 characters');
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(input.username)) {
      throw new Error('Username can only contain letters, numbers, and underscores');
    }

    // Validate email format if provided
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      throw new Error('Invalid email format');
    }

    // Validate phone format if provided (E.164 format)
    if (input.phone && !/^\+[1-9]\d{1,14}$/.test(input.phone)) {
      throw new Error('Phone number must be in E.164 format (e.g., +1234567890)');
    }

    const userId = input.id ? brand(input.id) : brand(crypto.randomUUID());

    return new User(
      userId,
      input.username,
      input.email,
      input.phone,
      input.name,
      input.profileVisibility || ProfileVisibility.PUBLIC,
      false, // isVerified defaults to false
      {
        totalItems: 0,
        booksCount: 0,
        papersCount: 0,
        articlesCount: 0,
        streakDays: 0
      }
    );
  }

  // Getters (immutable access)
  getId(): UserId {
    return this.id;
  }

  getUsername(): string {
    return this.username;
  }

  getEmail(): string | undefined {
    return this.email;
  }

  getPhone(): string | undefined {
    return this.phone;
  }

  getName(): string | undefined {
    return this.name;
  }

  getProfileVisibility(): ProfileVisibility {
    return this.profileVisibility;
  }

  getIsVerified(): boolean {
    return this.isVerified;
  }

  getStats(): Readonly<UserStats> {
    return { ...this.stats };
  }

  getLastReadDate(): Date | undefined {
    return this.lastReadDate;
  }

  getCreatedAt(): Date {
    return this.createdAt;
  }

  getUpdatedAt(): Date {
    return this.updatedAt;
  }

  /**
   * Check if this user can follow another user
   */
  canFollow(targetUserId: UserId): boolean {
    // Cannot follow yourself
    if (this.id === targetUserId) {
      return false;
    }

    // Only public profiles can be followed
    // Note: This would need to be enhanced to check target user's visibility
    return true;
  }

  /**
   * Check if the user's profile is publicly visible
   */
  isProfilePublic(): boolean {
    return this.profileVisibility === ProfileVisibility.PUBLIC;
  }

  /**
   * Check if the user's profile is unlisted
   */
  isProfileUnlisted(): boolean {
    return this.profileVisibility === ProfileVisibility.UNLISTED;
  }

  /**
   * Check if the user's profile is private
   */
  isProfilePrivate(): boolean {
    return this.profileVisibility === ProfileVisibility.PRIVATE;
  }

  /**
   * Increment reading streak
   */
  incrementStreak(): User {
    const newStats = {
      ...this.stats,
      streakDays: this.stats.streakDays + 1,
      lastReadDate: new Date()
    };

    return new User(
      this.id,
      this.username,
      this.email,
      this.phone,
      this.name,
      this.profileVisibility,
      this.isVerified,
      newStats,
      new Date(),
      this.createdAt,
      new Date()
    );
  }

  /**
   * Update user statistics after adding an item
   */
  updateStatsForNewItem(itemType: 'BOOK' | 'PAPER' | 'ARTICLE'): User {
    const newStats = { ...this.stats };
    newStats.totalItems += 1;

    switch (itemType) {
      case 'BOOK':
        newStats.booksCount += 1;
        break;
      case 'PAPER':
        newStats.papersCount += 1;
        break;
      case 'ARTICLE':
        newStats.articlesCount += 1;
        break;
    }

    return new User(
      this.id,
      this.username,
      this.email,
      this.phone,
      this.name,
      this.profileVisibility,
      this.isVerified,
      newStats,
      this.lastReadDate,
      this.createdAt,
      new Date()
    );
  }

  /**
   * Reset reading streak (called when user hasn't read in 24h)
   */
  resetStreak(): User {
    const newStats = {
      ...this.stats,
      streakDays: 0
    };

    return new User(
      this.id,
      this.username,
      this.email,
      this.phone,
      this.name,
      this.profileVisibility,
      this.isVerified,
      newStats,
      this.lastReadDate,
      this.createdAt,
      new Date()
    );
  }

  /**
   * Update profile visibility
   */
  updateVisibility(visibility: ProfileVisibility): User {
    return new User(
      this.id,
      this.username,
      this.email,
      this.phone,
      this.name,
      visibility,
      this.isVerified,
      this.stats,
      this.lastReadDate,
      this.createdAt,
      new Date()
    );
  }

  /**
   * Mark user as verified
   */
  verify(): User {
    return new User(
      this.id,
      this.username,
      this.email,
      this.phone,
      this.name,
      this.profileVisibility,
      true, // isVerified = true
      this.stats,
      this.lastReadDate,
      this.createdAt,
      new Date()
    );
  }

  /**
   * Update user's name
   */
  updateName(name: string): User {
    return new User(
      this.id,
      this.username,
      this.email,
      this.phone,
      name,
      this.profileVisibility,
      this.isVerified,
      this.stats,
      this.lastReadDate,
      this.createdAt,
      new Date()
    );
  }

  /**
   * Convert to plain object for DTOs and persistence
   */
  toPlainObject(): {
    id: string;
    username: string;
    email?: string;
    phone?: string;
    name?: string;
    profileVisibility: ProfileVisibility;
    isVerified: boolean;
    stats: UserStats;
    lastReadDate?: Date;
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      id: this.id,
      username: this.username,
      email: this.email,
      phone: this.phone,
      name: this.name,
      profileVisibility: this.profileVisibility,
      isVerified: this.isVerified,
      stats: this.stats,
      lastReadDate: this.lastReadDate,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}
