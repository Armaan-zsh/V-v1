/**
 * Mock implementations for testing
 */

import { IItemRepository } from '../../src/core/repositories/IItemRepository';
import { IUserRepository } from '../../src/core/repositories/IUserRepository';
import { PaginatedResult, SearchResult } from '../../src/core/repositories/common';

export class MockItemRepository implements IItemRepository {
  public mockKeywordResults: Array<{ id: string; score: number; type: 'keyword' }> = [];
  public lastSearchFilters: any = null;
  
  constructor(private items: any[] = []) {}

  async findById(id: string) {
    return this.items.find(item => item.id === id) || null;
  }

  async findByUserId(userId: string, options?: any) {
    const userItems = this.items.filter(item => item.userId === userId);
    return {
      items: userItems,
      total: userItems.length,
      hasMore: false,
      nextCursor: null,
    } as PaginatedResult<any>;
  }

  async create(data: any) {
    const newItem = {
      id: Math.random().toString(36).substring(7),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.push(newItem);
    return newItem;
  }

  async update(id: string, data: any) {
    const index = this.items.findIndex(item => item.id === id);
    if (index !== -1) {
      this.items[index] = { ...this.items[index], ...data, updatedAt: new Date() };
      return this.items[index];
    }
    return null;
  }

  async delete(id: string) {
    const index = this.items.findIndex(item => item.id === id);
    if (index !== -1) {
      this.items.splice(index, 1);
      return true;
    }
    return false;
  }

  async search(query: any, options?: any) {
    this.lastSearchFilters = options?.filters;
    
    if (this.mockKeywordResults.length > 0) {
      return {
        items: this.mockKeywordResults.map(result => ({
          ...this.items.find(item => item.id === result.id),
          searchScore: result.score,
        })),
        total: this.mockKeywordResults.length,
      } as SearchResult<any>;
    }
    
    return {
      items: [],
      total: 0,
    } as SearchResult<any>;
  }

  async getItemsByStatus(userId: string, status: any) {
    return this.items.filter(item => item.userId === userId && item.status === status);
  }

  async getItemsByType(userId: string, type: any) {
    return this.items.filter(item => item.userId === userId && item.type === type);
  }

  async getRecentlyAdded(userId: string, limit: number = 10) {
    return this.items
      .filter(item => item.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  async getTopRated(userId: string, limit: number = 10) {
    return this.items
      .filter(item => item.userId === userId && item.rating)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, limit);
  }
}

export class MockUserRepository implements IUserRepository {
  private users = [
    {
      id: 'user1',
      username: 'john_doe',
      email: 'john@example.com',
      displayName: 'John Doe',
      profileVisibility: 'PUBLIC' as const,
    },
    {
      id: 'user2',
      username: 'jane_smith',
      email: 'jane@example.com',
      displayName: 'Jane Smith',
      profileVisibility: 'PUBLIC' as const,
    },
  ];

  async findById(id: string) {
    return this.users.find(user => user.id === id) || null;
  }

  async findByEmail(email: string) {
    return this.users.find(user => user.email === email) || null;
  }

  async findByUsername(username: string) {
    return this.users.find(user => user.username === username) || null;
  }

  async create(data: any) {
    const newUser = {
      id: Math.random().toString(36).substring(7),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.push(newUser);
    return newUser;
  }

  async update(id: string, data: any) {
    const index = this.users.findIndex(user => user.id === id);
    if (index !== -1) {
      this.users[index] = { ...this.users[index], ...data, updatedAt: new Date() };
      return this.users[index];
    }
    return null;
  }

  async delete(id: string) {
    const index = this.users.findIndex(user => user.id === id);
    if (index !== -1) {
      this.users.splice(index, 1);
      return true;
    }
    return false;
  }

  async searchUsers(query: string, options?: any) {
    const matchingUsers = this.users.filter(user => 
      user.username.toLowerCase().includes(query.toLowerCase()) ||
      (user.displayName && user.displayName.toLowerCase().includes(query.toLowerCase()))
    );
    
    return {
      users: matchingUsers,
      total: matchingUsers.length,
    } as SearchResult<any>;
  }

  async getFollowers(userId: string, options?: any) {
    // Mock implementation
    return {
      users: [],
      total: 0,
    } as SearchResult<any>;
  }

  async getFollowing(userId: string, options?: any) {
    // Mock implementation
    return {
      users: [],
      total: 0,
    } as SearchResult<any>;
  }

  async follow(followerId: string, followingId: string) {
    // Mock implementation
    return true;
  }

  async unfollow(followerId: string, followingId: string) {
    // Mock implementation
    return true;
  }

  async getUserStats(userId: string) {
    return {
      totalItems: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      streakDays: 0,
    };
  }
}