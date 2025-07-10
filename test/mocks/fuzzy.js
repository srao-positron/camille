// Mock for fuzzy
module.exports = {
  filter: jest.fn((input, list) => {
    return list.filter(item => item.toLowerCase().includes(input.toLowerCase())).map(item => ({
      original: item,
      string: item
    }));
  })
};