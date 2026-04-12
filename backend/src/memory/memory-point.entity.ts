import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MemoryPointOp = 'new' | 'supplement' | 'revise' | 'conflict';

@Entity('memory_points')
@Index('idx_memory_points_user_line', ['userId', 'lineId'])
@Index('idx_memory_points_source', ['sourcePointId'])
@Index('idx_memory_points_line_memory_date', ['lineId', 'memoryDate'])
export class MemoryPoint {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'session_id', type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ name: 'line_id', type: 'varchar', length: 36 })
  lineId: string;

  @Column({ type: 'varchar', length: 16 })
  op: MemoryPointOp;

  @Column({ name: 'source_point_id', type: 'varchar', length: 36, nullable: true })
  sourcePointId: string | null;

  @Column({ type: 'text' })
  text: string;

  @Column({ name: 'memory_date', type: 'date' })
  memoryDate: string;

  @Column({ name: 'salience_score', type: 'double', default: 1 })
  salienceScore: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
