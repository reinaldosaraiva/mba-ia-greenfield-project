import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ALL_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature([Video])', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
