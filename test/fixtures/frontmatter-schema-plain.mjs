/** a hand-rolled Standard Schema export (no library): `title` must be a string */
export const frontmatter = {
  '~standard': {
    version: 1,
    vendor: 'fixture',
    validate(value) {
      const title = value && typeof value === 'object' ? value.title : undefined;
      return typeof title === 'string' ? { value } : { issues: [{ message: 'title must be a string', path: ['title'] }] };
    },
  },
};
