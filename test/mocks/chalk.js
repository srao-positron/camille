// Mock for chalk
const createChalkMock = () => {
  const mock = (str) => str;
  
  // Add all common chalk methods
  const colors = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'gray', 'black'];
  const modifiers = ['bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strikethrough'];
  
  [...colors, ...modifiers].forEach(name => {
    mock[name] = mock;
  });
  
  // Support chaining
  colors.forEach(color => {
    modifiers.forEach(mod => {
      if (!mock[color][mod]) {
        mock[color][mod] = mock;
      }
    });
  });
  
  return mock;
};

module.exports = createChalkMock();
module.exports.default = module.exports;