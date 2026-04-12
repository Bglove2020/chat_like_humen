import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('point_revision_logs')
@Index('idx_point_revision_logs_point_id', ['pointId'])
export class PointRevisionLog {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ name: 'point_id', type: 'varchar', length: 36 })
  pointId: string;

  @Column({ name: 'before_text', type: 'text' })
  beforeText: string;

  @Column({ name: 'after_text', type: 'text' })
  afterText: string;

  @Column({ name: 'batch_id', type: 'varchar', length: 128 })
  batchId: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}
