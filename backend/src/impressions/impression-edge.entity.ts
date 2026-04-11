import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('impression_edges')
@Index(['userId', 'toImpressionId'])
@Index(['fromImpressionId', 'toImpressionId', 'batchId'], { unique: true })
export class ImpressionEdge {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'varchar', length: 64 })
  fromImpressionId: string;

  @Column({ type: 'varchar', length: 64 })
  toImpressionId: string;

  @Column({ type: 'varchar', length: 32, default: 'continued_from' })
  relationType: string;

  @Column({ type: 'varchar', length: 128 })
  batchId: string;

  @CreateDateColumn()
  createdAt: Date;
}
