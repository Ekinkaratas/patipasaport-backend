import { Controller, Get } from '@nestjs/common';
import { Public } from '@libs/common';

@Controller()
export class AppController {
  @Public()
  @Get('health')
  healthCheck() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
