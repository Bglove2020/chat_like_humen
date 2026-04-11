import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('user_profiles')
@Index('idx_user', ['userId'])
export class UserProfile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id', type: 'int', unique: true })
  userId: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  name: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  nickname: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  age_range: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  gender: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  birthday: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  zodiac: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  location: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  hometown: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  ethnicity: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  education: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  major: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  school: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  occupation: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  work_years: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  marital_status: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  has_children: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  pet: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  family_structure: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  diet: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  exercise: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sleep_schedule: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  smoking: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  drinking: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  cooking: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  hobbies: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  favorite_food: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  favorite_drink: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  favorite_music: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  favorite_sport: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  favorite_books: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  favorite_movies: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  favorite_travel: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
