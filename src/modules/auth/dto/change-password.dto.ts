import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { StrongPassword } from './password-fields';

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  currentPassword: string;

  @StrongPassword()
  newPassword: string;
}
