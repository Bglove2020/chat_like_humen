import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('chat_sessions')
@Index(['userId', 'updatedAt'])
export class ChatSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'varchar', length: 120, default: 'New Chat' })
  title: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  difyConversationId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
