import { Body, Controller, Get, HttpCode, Post, ServiceUnavailableException } from '@nestjs/common';
import { AppService, FraudResponse, TransactionBodyDto } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get('ready')
  isReady() {
    if (!this.appService.getIsReady()) {
      throw new ServiceUnavailableException('Initializing index...');
    }
    return 'The application is ready!';
  }

  @Post('fraud-score')
  @HttpCode(200)
  fraudScore(@Body() body: TransactionBodyDto): FraudResponse {
    return this.appService.execute(body);
  }
}
