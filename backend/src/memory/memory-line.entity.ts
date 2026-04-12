import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('memory_lines')
@Index('idx_memory_lines_user_last_activated_at', ['userId', 'lastActivatedAt'])
export class MemoryLine {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'session_id', type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ name: 'anchor_label', type: 'varchar', length: 255 })
  anchorLabel: string;

  @Column({ name: 'impression_label', type: 'varchar', length: 255 })
  impressionLabel: string;

  @Column({ name: 'impression_abstract', type: 'text' })
  impressionAbstract: string;

  @Column({ name: 'impression_version', type: 'int', default: 1 })
  impressionVersion: number;

  @Column({ name: 'salience_score', type: 'double', default: 1 })
  salienceScore: number;

  @Column({ name: 'last_activated_at', type: 'datetime' })
  lastActivatedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
