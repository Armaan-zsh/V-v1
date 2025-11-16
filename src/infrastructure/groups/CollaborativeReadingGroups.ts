import { prisma } from '../database/prisma';
import { redis } from '../database/redis';
import pino from 'pino';
import { z } from 'zod';

// Types for collaborative reading groups
export interface ReadingGroup {
  id: string;
  name: string;
  description: string;
  privacy: 'public' | 'private' | 'invite_only';
  creatorId: string;
  members: GroupMember[];
  currentBook?: GroupBook;
  readingGoals: GroupGoal[];
  createdAt: Date;
  updatedAt: Date;
  metadata?: {
    avatar?: string;
    banner?: string;
    tags?: string[];
    maxMembers?: number;
    readingPace?: 'slow' | 'moderate' | 'fast';
    genre?: string;
  };
}

export interface GroupMember {
  id: string;
  userId: string;
  groupId: string;
  role: 'admin' | 'moderator' | 'member';
  joinedAt: Date;
  lastActivity: Date;
  readingStats: {
    booksCompleted: number;
    currentStreak: number;
    totalReadingTime: number;
    postsCreated: number;
  };
  status: 'active' | 'inactive' | 'banned';
}

export interface GroupBook {
  id: string;
  groupId: string;
  itemId: string;
  startedAt: Date;
  scheduledEndDate?: Date;
  actualEndDate?: Date;
  status: 'reading' | 'completed' | 'paused' | 'cancelled';
  currentPage?: number;
  totalPages?: number;
  memberProgress: Array<{
    userId: string;
    progress: number; // 0-1
    lastUpdate: Date;
  }>;
  discussions: GroupDiscussion[];
}

export interface GroupDiscussion {
  id: string;
  groupId: string;
  bookId?: string;
  title: string;
  content: string;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  replies: GroupReply[];
  likes: number;
  tags: string[];
  pinned: boolean;
  locked: boolean;
}

export interface GroupReply {
  id: string;
  discussionId: string;
  content: string;
  authorId: string;
  parentReplyId?: string;
  createdAt: Date;
  updatedAt: Date;
  likes: number;
  mentions: string[]; // User IDs mentioned
}

export interface GroupGoal {
  id: string;
  groupId: string;
  title: string;
  description: string;
  type: 'books_per_month' | 'pages_per_week' | 'reading_streak' | 'discussion_participation';
  target: number;
  current: number;
  startDate: Date;
  endDate: Date;
  createdBy: string;
  participants: string[]; // User IDs participating
  status: 'active' | 'completed' | 'failed' | 'paused';
}

export interface CreateGroupInput {
  name: string;
  description: string;
  privacy: 'public' | 'private' | 'invite_only';
  metadata?: {
    avatar?: string;
    banner?: string;
    tags?: string[];
    maxMembers?: number;
    readingPace?: 'slow' | 'moderate' | 'fast';
    genre?: string;
  };
}

export interface JoinGroupInput {
  groupId: string;
  userId: string;
  message?: string; // For private/invite-only groups
}

export interface StartGroupBookInput {
  groupId: string;
  itemId: string;
  startDate?: Date;
  scheduledEndDate?: Date;
  discussionTopic?: string;
}

export interface CreateDiscussionInput {
  groupId: string;
  title: string;
  content: string;
  bookId?: string;
  tags?: string[];
}

// Validation schemas
export const CreateGroupSchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().min(10).max(1000),
  privacy: z.enum(['public', 'private', 'invite_only']),
  metadata: z.object({
    avatar: z.string().optional(),
    banner: z.string().optional(),
    tags: z.array(z.string()).max(10).optional(),
    maxMembers: z.number().min(5).max(1000).optional(),
    readingPace: z.enum(['slow', 'moderate', 'fast']).optional(),
    genre: z.string().optional(),
  }).optional(),
});

export const JoinGroupSchema = z.object({
  groupId: z.string().uuid(),
  userId: z.string().uuid(),
  message: z.string().max(500).optional(),
});

export const StartGroupBookSchema = z.object({
  groupId: z.string().uuid(),
  itemId: z.string().uuid(),
  startDate: z.date().optional(),
  scheduledEndDate: z.date().optional(),
  discussionTopic: z.string().max(200).optional(),
});

export class CollaborativeReadingGroups {
  private logger: pino.Logger;
  private readonly CACHE_TTL = 1800; // 30 minutes
  private readonly MAX_MEMBERS = 100;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });
  }

  /**
   * Create a new reading group
   */
  async createGroup(userId: string, input: CreateGroupInput): Promise<ReadingGroup> {
    try {
      const validatedInput = CreateGroupSchema.parse(input);

      // Check if user exists
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Create group in database
      const group = await prisma.readingGroup.create({
        data: {
          name: validatedInput.name,
          description: validatedInput.description,
          privacy: validatedInput.privacy,
          creatorId: userId,
          metadata: validatedInput.metadata,
        },
        include: {
          members: true,
          readingGoals: true,
        },
      });

      // Add creator as admin member
      await prisma.groupMember.create({
        data: {
          groupId: group.id,
          userId: userId,
          role: 'admin',
          status: 'active',
        },
      });

      // Create initial group goal (optional)
      await this.createDefaultGroupGoals(group.id, userId);

      this.logger.info('Reading group created', {
        groupId: group.id,
        name: group.name,
        creatorId: userId,
        privacy: group.privacy,
      });

      return {
        ...group,
        members: group.members.map(member => ({
          ...member,
          userId: member.userId,
          groupId: member.groupId,
          readingStats: {
            booksCompleted: 0,
            currentStreak: 0,
            totalReadingTime: 0,
            postsCreated: 0,
          },
        })),
      };

    } catch (error) {
      this.logger.error('Failed to create reading group', { userId, input, error });
      throw error;
    }
  }

  /**
   * Join a reading group
   */
  async joinGroup(input: JoinGroupInput): Promise<{ success: boolean; message?: string }> {
    try {
      const validatedInput = JoinGroupSchema.parse(input);

      const group = await prisma.readingGroup.findUnique({
        where: { id: validatedInput.groupId },
        include: {
          members: true,
        },
      });

      if (!group) {
        throw new Error('Group not found');
      }

      // Check if user is already a member
      const existingMember = group.members.find(m => m.userId === validatedInput.userId);
      if (existingMember) {
        if (existingMember.status === 'active') {
          return { success: true, message: 'Already a member of this group' };
        } else {
          // Reactivate banned/inactive member
          await prisma.groupMember.update({
            where: { id: existingMember.id },
            data: { status: 'active' },
          });
          return { success: true, message: 'Membership reactivated' };
        }
      }

      // Check group privacy and capacity
      if (group.privacy === 'private' || group.privacy === 'invite_only') {
        // For private/invite-only groups, create join request
        await prisma.groupJoinRequest.create({
          data: {
            groupId: group.id,
            userId: validatedInput.userId,
            message: validatedInput.message,
          },
        });
        return { 
          success: false, 
          message: 'Join request sent to group administrators' 
        };
      }

      // Check member limit
      const maxMembers = group.metadata?.maxMembers || this.MAX_MEMBERS;
      if (group.members.length >= maxMembers) {
        return { 
          success: false, 
          message: 'Group has reached maximum member capacity' 
        };
      }

      // Add user as member
      await prisma.groupMember.create({
        data: {
          groupId: group.id,
          userId: validatedInput.userId,
          role: 'member',
          status: 'active',
        },
      });

      // Log activity
      await this.logGroupActivity(group.id, 'user_joined', {
        userId: validatedInput.userId,
      });

      this.logger.info('User joined reading group', {
        groupId: group.id,
        userId: validatedInput.userId,
      });

      return { success: true, message: 'Successfully joined the group' };

    } catch (error) {
      this.logger.error('Failed to join reading group', { input, error });
      throw error;
    }
  }

  /**
   * Leave a reading group
   */
  async leaveGroup(groupId: string, userId: string): Promise<void> {
    try {
      const member = await prisma.groupMember.findFirst({
        where: {
          groupId,
          userId,
        },
      });

      if (!member) {
        throw new Error('User is not a member of this group');
      }

      // Check if user is the creator/admin
      const group = await prisma.readingGroup.findUnique({
        where: { id: groupId },
      });

      if (group?.creatorId === userId) {
        throw new Error('Group creator cannot leave the group. Transfer ownership or delete the group instead.');
      }

      // Remove membership
      await prisma.groupMember.delete({
        where: { id: member.id },
      });

      // Log activity
      await this.logGroupActivity(groupId, 'user_left', {
        userId,
      });

      this.logger.info('User left reading group', {
        groupId,
        userId,
      });

    } catch (error) {
      this.logger.error('Failed to leave reading group', { groupId, userId, error });
      throw error;
    }
  }

  /**
   * Start a group book reading session
   */
  async startGroupBook(input: StartGroupBookInput): Promise<GroupBook> {
    try {
      const validatedInput = StartGroupBookSchema.parse(input);

      // Verify user is a member with sufficient permissions
      const member = await prisma.groupMember.findFirst({
        where: {
          groupId: validatedInput.groupId,
          userId: validatedInput.userId, // We'll need to pass userId in the input
          status: 'active',
        },
      });

      if (!member) {
        throw new Error('User must be a member of the group to start a book');
      }

      // Check if there's already an active book
      const activeBook = await prisma.groupBook.findFirst({
        where: {
          groupId: validatedInput.groupId,
          status: 'reading',
        },
      });

      if (activeBook) {
        throw new Error('Group already has an active book. Complete or pause it first.');
      }

      // Verify item exists
      const item = await prisma.item.findUnique({
        where: { id: validatedInput.itemId },
      });

      if (!item) {
        throw new Error('Book/item not found');
      }

      // Create group book
      const groupBook = await prisma.groupBook.create({
        data: {
          groupId: validatedInput.groupId,
          itemId: validatedInput.itemId,
          startedAt: validatedInput.startDate || new Date(),
          scheduledEndDate: validatedInput.scheduledEndDate,
          status: 'reading',
          memberProgress: {
            create: member.role === 'admin' || member.role === 'moderator' ? {
              userId: member.userId,
              progress: 0,
            } : undefined,
          },
        },
        include: {
          item: true,
          discussions: {
            include: {
              replies: true,
            },
            orderBy: {
              createdAt: 'desc',
            },
          },
          memberProgress: true,
        },
      });

      // Create initial discussion if topic provided
      if (validatedInput.discussionTopic) {
        await this.createGroupDiscussion({
          groupId: validatedInput.groupId,
          title: `Discussion: ${validatedInput.discussionTopic}`,
          content: `Let's discuss our thoughts on "${item.title}" as we read together!`,
          bookId: groupBook.id,
          tags: ['group-discussion', 'book-start'],
        });
      }

      // Log activity
      await this.logGroupActivity(validatedInput.groupId, 'book_started', {
        bookId: groupBook.id,
        itemId: validatedInput.itemId,
        title: item.title,
        userId: member.userId,
      });

      this.logger.info('Group book started', {
        groupId: validatedInput.groupId,
        bookId: groupBook.id,
        itemId: validatedInput.itemId,
      });

      return {
        ...groupBook,
        discussions: groupBook.discussions,
      };

    } catch (error) {
      this.logger.error('Failed to start group book', { input, error });
      throw error;
    }
  }

  /**
   * Create a group discussion
   */
  async createGroupDiscussion(input: CreateDiscussionInput): Promise<GroupDiscussion> {
    try {
      const { groupId, title, content, bookId, tags = [] } = input;

      // Verify user is a member
      const member = await prisma.groupMember.findFirst({
        where: {
          groupId,
          userId: input.userId, // Need to add userId to input
          status: 'active',
        },
      });

      if (!member) {
        throw new Error('User must be a member to create discussions');
      }

      // Create discussion
      const discussion = await prisma.groupDiscussion.create({
        data: {
          groupId,
          bookId,
          title,
          content,
          authorId: input.userId,
          tags,
        },
        include: {
          replies: true,
        },
      });

      // Log activity
      await this.logGroupActivity(groupId, 'discussion_created', {
        discussionId: discussion.id,
        title,
        userId: input.userId,
      });

      this.logger.info('Group discussion created', {
        discussionId: discussion.id,
        groupId,
        title,
      });

      return discussion;

    } catch (error) {
      this.logger.error('Failed to create group discussion', { input, error });
      throw error;
    }
  }

  /**
   * Update reading progress for group book
   */
  async updateReadingProgress(
    groupId: string, 
    userId: string, 
    progress: number,
    currentPage?: number
  ): Promise<void> {
    try {
      // Find active group book
      const groupBook = await prisma.groupBook.findFirst({
        where: {
          groupId,
          status: 'reading',
        },
      });

      if (!groupBook) {
        throw new Error('No active group book found');
      }

      // Update member progress
      const existingProgress = await prisma.memberProgress.findFirst({
        where: {
          bookId: groupBook.id,
          userId,
        },
      });

      if (existingProgress) {
        await prisma.memberProgress.update({
          where: { id: existingProgress.id },
          data: {
            progress,
            lastUpdate: new Date(),
            ...(currentPage && { currentPage }),
          },
        });
      } else {
        await prisma.memberProgress.create({
          data: {
            bookId: groupBook.id,
            userId,
            progress,
            lastUpdate: new Date(),
            ...(currentPage && { currentPage }),
          },
        });
      }

      // Check if everyone has finished (progress >= 0.9)
      const allProgress = await prisma.memberProgress.findMany({
        where: { bookId: groupBook.id },
      });

      if (allProgress.length > 0 && allProgress.every(p => p.progress >= 0.9)) {
        // Auto-complete the book
        await prisma.groupBook.update({
          where: { id: groupBook.id },
          data: {
            status: 'completed',
            actualEndDate: new Date(),
          },
        });

        await this.logGroupActivity(groupId, 'book_completed', {
          bookId: groupBook.id,
          completedBy: userId,
        });
      }

      this.logger.debug('Reading progress updated', {
        groupId,
        userId,
        progress,
        currentPage,
      });

    } catch (error) {
      this.logger.error('Failed to update reading progress', { 
        groupId, 
        userId, 
        progress, 
        error 
      });
      throw error;
    }
  }

  /**
   * Get group details with member list and current activity
   */
  async getGroup(groupId: string, userId?: string): Promise<ReadingGroup | null> {
    try {
      const group = await prisma.readingGroup.findUnique({
        where: { id: groupId },
        include: {
          members: {
            where: { status: 'active' },
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  avatar: true,
                },
              },
            },
          },
          currentBook: {
            include: {
              item: true,
              memberProgress: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      avatar: true,
                    },
                  },
                },
              },
              discussions: {
                include: {
                  author: {
                    select: {
                      id: true,
                      name: true,
                      avatar: true,
                    },
                  },
                  replies: {
                    include: {
                      author: {
                        select: {
                          id: true,
                          name: true,
                          avatar: true,
                        },
                      },
                    },
                  },
                },
                orderBy: [
                  { pinned: 'desc' },
                  { createdAt: 'desc' },
                ],
              },
            },
          },
          readingGoals: {
            where: { status: 'active' },
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!group) {
        return null;
      }

      // Check if user has access (for private groups)
      if (group.privacy === 'private' || group.privacy === 'invite_only') {
        if (!userId || !group.members.some(m => m.userId === userId)) {
          // Return limited information for non-members
          return {
            ...group,
            members: [],
            currentBook: undefined,
            readingGoals: [],
          };
        }
      }

      return group;

    } catch (error) {
      this.logger.error('Failed to get group', { groupId, userId, error });
      throw error;
    }
  }

  /**
   * Search for groups
   */
  async searchGroups(query: string, filters: {
    privacy?: 'public' | 'private' | 'invite_only';
    genre?: string;
    readingPace?: 'slow' | 'moderate' | 'fast';
    tags?: string[];
    limit?: number;
  } = {}): Promise<ReadingGroup[]> {
    try {
      const whereClause: any = {
        privacy: filters.privacy || 'public',
      };

      if (query) {
        whereClause.OR = [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ];
      }

      if (filters.genre) {
        whereClause['metadata'] = {
          path: ['genre'],
          equals: filters.genre,
        };
      }

      if (filters.readingPace) {
        whereClause['metadata'] = {
          path: ['readingPace'],
          equals: filters.readingPace,
        };
      }

      const groups = await prisma.readingGroup.findMany({
        where: whereClause,
        include: {
          _count: {
            select: {
              members: {
                where: { status: 'active' },
              },
            },
          },
          currentBook: {
            include: {
              item: {
                select: {
                  id: true,
                  title: true,
                  author: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: filters.limit || 20,
      });

      return groups;

    } catch (error) {
      this.logger.error('Failed to search groups', { query, filters, error });
      throw error;
    }
  }

  /**
   * Create default group goals
   */
  private async createDefaultGroupGoals(groupId: string, createdBy: string): Promise<void> {
    const defaultGoals = [
      {
        title: 'Complete 1 Book This Month',
        description: 'Every member reads at least one book this month',
        type: 'books_per_month' as const,
        target: 1,
        current: 0,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        participants: [createdBy],
      },
      {
        title: 'Weekly Reading Check-ins',
        description: 'Share weekly updates on reading progress',
        type: 'discussion_participation' as const,
        target: 4, // 4 check-ins per month
        current: 0,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        participants: [createdBy],
      },
    ];

    for (const goal of defaultGoals) {
      await prisma.groupGoal.create({
        data: {
          groupId,
          title: goal.title,
          description: goal.description,
          type: goal.type,
          target: goal.target,
          current: goal.current,
          startDate: goal.startDate,
          endDate: goal.endDate,
          createdBy,
          participants: goal.participants,
          status: 'active',
        },
      });
    }
  }

  /**
   * Log group activity for activity feed
   */
  private async logGroupActivity(
    groupId: string, 
    activityType: string, 
    data: any
  ): Promise<void> {
    try {
      // This would integrate with the ActivityFeedEngine
      this.logger.debug('Group activity logged', {
        groupId,
        activityType,
        data,
      });

      // In a real implementation:
      // await activityFeedEngine.trackGroupActivity(groupId, activityType, data);

    } catch (error) {
      this.logger.error('Failed to log group activity', { groupId, activityType, data, error });
    }
  }

  /**
   * Get group statistics
   */
  async getGroupStats(groupId: string): Promise<{
    totalMembers: number;
    activeMembers: number;
    booksCompleted: number;
    discussionsCreated: number;
    averageReadingProgress: number;
    memberRoles: Record<string, number>;
  }> {
    try {
      const group = await prisma.readingGroup.findUnique({
        where: { id: groupId },
        include: {
          members: true,
          currentBook: {
            include: {
              memberProgress: true,
            },
          },
        },
      });

      if (!group) {
        throw new Error('Group not found');
      }

      const totalMembers = group.members.length;
      const activeMembers = group.members.filter(m => m.status === 'active').length;
      
      const completedBooks = await prisma.groupBook.count({
        where: {
          groupId,
          status: 'completed',
        },
      });

      const discussions = await prisma.groupDiscussion.count({
        where: { groupId },
      });

      const currentProgress = group.currentBook?.memberProgress || [];
      const averageProgress = currentProgress.length > 0
        ? currentProgress.reduce((sum, p) => sum + p.progress, 0) / currentProgress.length
        : 0;

      const memberRoles = group.members.reduce((acc, member) => {
        acc[member.role] = (acc[member.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return {
        totalMembers,
        activeMembers,
        booksCompleted: completedBooks,
        discussionsCreated: discussions,
        averageReadingProgress: Math.round(averageProgress * 100) / 100,
        memberRoles,
      };

    } catch (error) {
      this.logger.error('Failed to get group stats', { groupId, error });
      throw error;
    }
  }
}