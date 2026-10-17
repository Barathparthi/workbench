import type { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import type { Application } from '@theia/core/shared/express';
import { injectable } from '@theia/core/shared/inversify';

/**
 * 32×32 PNG rendered from resources/qe-logo.svg. Embedded because the backend is bundled into the app,
 * so files next to this module are not there at runtime.
 */
export const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADlklEQVR4nMRXW0gUURj+ZnbL3LXS1dyMMrXsQmaWWQpqFmJY9GAR' +
    'gYmaRVEPmS8V9ZRRdIF6yEAi0weVoESkyMIupj4U5L0tscwrmhq63lbXdXc658iaMqOua+5+MJw55z/zfz//+S9z5JiMxHxnhcGY' +
    'Qt6COY4LIKM7/g+6BEGoIuMn3SLZfWTFaM0CzvyiOJ4fDZgecxxWYQEhCGgH+FO6nJjCCQOUsc/3g+dew4YQBP4ANYJD7EsXBa/X' +
    'EEs8YENQT+hGjVvljpw+wdbkFPSoHRfL4uU8CTjYCZSbF+xoAOWWE1eshZ1AueWWbHRf7oBAHxds8FiK+o4BfGnoRXe/XrSPJ8GU' +
    'dnIHvNVOIpl+1Ii0Nz/xtqZzyvqMBigdZERhII6GrBbJcstakJJViSG9cWJtu7cL4vd4TatvUD9muQFeK5QovBqGNa4KSXlsqCdC' +
    'N7kh+mYJmrt1bE1BDDajtqUPWp1hYk49kFXcJNIjaQA5Gzw5F8TIewZHce2ZBsWaLrT1DGO1yhERW9yReswPnm4KZJwNQmTqR5GO' +
    'i9nVKP3+B7OBl1pMObgBu9araLFA9I0SZLxvREPnEPQGExvp/NCtMiYP9nXF+WhfWAtJAxIivNn4rrYTmrZ+yQ8rGnuZfHy/l0ju' +
    '7+mMsM1u7Alap8IiGSepR/II1CTqKeo7BjETfvweRKS/Gh4ujiLZ7Tj/KXPqteTMStE+SQ8MjYyxkZM2WoRh/disewR6XhKQ9EB1' +
    'cx+inJeQvHfCTDDLKxq1Itml7BrUtIyvj4yaUNXUC4sNyPzQiKhtauzzU8NvzTJ8bf0XByuWOZD0DMfAsAE7fVRsLb2oQaSDklud' +
    'BS/K21FECgY9gldXwnFirzfWqZVYTFqX70onbFy1lAUWk1d2TASjNZi2EF0gVa6QkNNcf5C0fVoFrk4OLMINxqlnfCdum6gQSZVi' +
    'fjrFtLoFXS5C3uc2SbmmtY+Nu31VyE0OYX1AN6ksb/VcjjBSKc0PzZZEiXTllHF5AmbBShKQAV7OzPV17QOo+DXejO4lBOB0pA/b' +
    'cz3vG+4W1M25GVlkwEx4SAhpIcopbcaZR+WYK+ZtAAV1N23TtFTPFRb9D8wG2vmsBU/+i6zPofmCcNN/wirYCZSbFzjBfgYQbl4Y' +
    'k6WTdy1sDy3l5keexjSZBCTBxhBMXCLlZpVwOOdIPr2rjV8cF5iYcLB7Ye7hAjqf2vHtcD3/CwAA//93nHxoAAAABklEQVQDAC8P' +
    'aOKmT/HAAAAAAElFTkSuQmCC',
  'base64',
);

/** Theia's generated index.html links no icon, so browsers ask for /favicon.ico; answer with the QE logo. */
@injectable()
export class QeFaviconContribution implements BackendApplicationContribution {
  configure(app: Application): void {
    app.get('/favicon.ico', (_request, response) => {
      response.type('image/png').setHeader('Cache-Control', 'public, max-age=86400');
      response.send(FAVICON_PNG);
    });
  }
}
