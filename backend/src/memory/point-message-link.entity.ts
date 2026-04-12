import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('point_message_links')
@Index('idx_point_message_links_batch_id', ['batchId'])
export class PointMessageLink {
  @PrimaryColumn({ name: 'point_id', type: 'varchar', length: 36 })
  pointId: string;

  @PrimaryColumn({ name: 'message_id', type: 'int' })
  messageId: number;

  @PrimaryColumn({ name: 'batch_id', type: 'varchar', length: 128 })
  batchId: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}
