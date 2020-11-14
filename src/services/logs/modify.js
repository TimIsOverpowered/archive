module.exports = function () {
  return (context) => {
    if(context.result.data) {
      for (let i = 0; i < context.result.data.length; i++) {
        context.result.data[i].content_offset_seconds = parseFloat(
          context.result.data[i].content_offset_seconds
        );
      }
    }
  };
};
