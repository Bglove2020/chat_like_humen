import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException('用户名已存在');
    }
    const user = await this.usersService.create(dto.username, dto.password);
    const token = this.generateToken(user.id, user.username);
    return { success: true, token, user: { id: user.id, username: user.username } };
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByUsername(dto.username);
    if (!user) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const valid = await this.usersService.validatePassword(user, dto.password);
    if (!valid) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const token = this.generateToken(user.id, user.username);
    return { success: true, token, user: { id: user.id, username: user.username } };
  }

  private generateToken(userId: number, username: string) {
    return this.jwtService.sign({ userId, username });
  }
}
