import { describeContractRepository } from './contract-repository.suite';
import { MemoryContractRepository } from './memory-contract.repository';

let tick = 0;
describeContractRepository('memory', () => {
  // updatedAt нэмэгдэж байгааг шалгахын тулд цаг урагшилдаг clock
  const repo = new MemoryContractRepository({ now: () => new Date(Date.UTC(2026, 9, 28, 9, 0, 0) + ++tick * 1000) });
  return { repo, seed: async (input) => void repo.seed(input) };
});
