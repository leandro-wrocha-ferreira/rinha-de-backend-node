import { Body, Controller, Get, Post } from '@nestjs/common';
import { AppService, FraudResponse, TransactionBodyDto } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get('ready')
  isReady(): string {
    return 'The application is ready!';
  }

  @Post('fraud-score')
  fraudScore(@Body() body: TransactionBodyDto): FraudResponse {
    return this.appService.execute(body);
  }
}
