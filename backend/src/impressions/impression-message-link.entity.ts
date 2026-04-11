import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('impression_message_links')
@Index(['impressionId'])
@Index(['batchId'])
@Index(['impressionId', 'messageId', 'batchId'], { unique: true })
export class ImpressionMessageLink {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64 })
  impressionId: string;

  @Column({ type: 'int' })
  messageId: number;

  @Column({ type: 'varchar', length: 128 })
  batchId: string;

  @CreateDateColumn()
  createdAt: Date;
}
