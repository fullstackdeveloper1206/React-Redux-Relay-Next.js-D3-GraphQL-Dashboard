export default theme => ({
  "&::-webkit-scrollbar": {
    "-webkitAppearance": "none",
    width: `${theme.spacing.unit}px`,
    height: `${theme.spacing.unit}px`
  },
  "&::-webkit-scrollbar-track": {
    background: "transparent"
  },
  "&::-webkit-scrollbar-thumb": {
    cursor: "pointer",
    borderRadius: theme.shape.borderRadius / 2,
    background: theme.palette.primary.main,
    transition: "color 0.2s ease"
  },
  "&::-webkit-scrollbar-thumb:window-inactive": {
    background: theme.palette.primary.main
  },
  "&::-webkit-scrollbar-thumb:hover": {
    background: theme.palette.primary.light
  }
});
