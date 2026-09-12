/**
 * Small bundled collection so the room is populated before any import.
 * Shaped like a merged Letterboxd export (title/year/rating/watch date + URI).
 */
import type { Film } from '../types';
import { emptyFilm } from './letterboxd';

interface SampleRow {
  t: string;
  y: number;
  r: number;
  d: string;
  uri: string;
  dir: string;
  g: string[];
  rt: number;
}

const ROWS: SampleRow[] = [
  { t: 'In the Mood for Love', y: 2000, r: 5, d: '2024-02-14', uri: 'https://boxd.it/2a1u', dir: 'Wong Kar-wai', g: ['Drama', 'Romance'], rt: 98 },
  { t: 'Paris, Texas', y: 1984, r: 4.5, d: '2023-11-02', uri: 'https://boxd.it/29Sk', dir: 'Wim Wenders', g: ['Drama'], rt: 145 },
  { t: 'Stalker', y: 1979, r: 5, d: '2023-08-19', uri: 'https://boxd.it/29Gw', dir: 'Andrei Tarkovsky', g: ['Science Fiction', 'Drama'], rt: 162 },
  { t: 'Chungking Express', y: 1994, r: 4.5, d: '2024-01-05', uri: 'https://boxd.it/29Ma', dir: 'Wong Kar-wai', g: ['Romance', 'Comedy'], rt: 102 },
  { t: 'Blade Runner', y: 1982, r: 4.5, d: '2022-10-31', uri: 'https://boxd.it/29Yo', dir: 'Ridley Scott', g: ['Science Fiction', 'Thriller'], rt: 117 },
  { t: 'Portrait of a Lady on Fire', y: 2019, r: 5, d: '2024-03-08', uri: 'https://boxd.it/iCtE', dir: 'Céline Sciamma', g: ['Drama', 'Romance'], rt: 122 },
  { t: 'Spirited Away', y: 2001, r: 5, d: '2021-12-24', uri: 'https://boxd.it/2b9c', dir: 'Hayao Miyazaki', g: ['Animation', 'Fantasy'], rt: 125 },
  { t: 'The Thing', y: 1982, r: 4.5, d: '2023-10-28', uri: 'https://boxd.it/2a0o', dir: 'John Carpenter', g: ['Horror', 'Science Fiction'], rt: 109 },
  { t: 'Drive', y: 2011, r: 4, d: '2022-05-13', uri: 'https://boxd.it/1Pgs', dir: 'Nicolas Winding Refn', g: ['Crime', 'Thriller'], rt: 100 },
  { t: 'Perfect Days', y: 2023, r: 4.5, d: '2024-04-20', uri: 'https://boxd.it/DiuU', dir: 'Wim Wenders', g: ['Drama'], rt: 124 },
  { t: 'Suspiria', y: 1977, r: 4, d: '2023-10-13', uri: 'https://boxd.it/2aRW', dir: 'Dario Argento', g: ['Horror'], rt: 99 },
  { t: 'Aftersun', y: 2022, r: 4.5, d: '2023-01-15', uri: 'https://boxd.it/uOx4', dir: 'Charlotte Wells', g: ['Drama'], rt: 102 },
  { t: 'Seven Samurai', y: 1954, r: 5, d: '2022-07-04', uri: 'https://boxd.it/2aXw', dir: 'Akira Kurosawa', g: ['Action', 'Drama'], rt: 207 },
  { t: 'The Grand Budapest Hotel', y: 2014, r: 4, d: '2021-06-01', uri: 'https://boxd.it/5UvY', dir: 'Wes Anderson', g: ['Comedy', 'Drama'], rt: 100 },
  { t: 'Mulholland Drive', y: 2001, r: 4.5, d: '2023-03-11', uri: 'https://boxd.it/29Ay', dir: 'David Lynch', g: ['Mystery', 'Thriller'], rt: 147 },
  { t: 'Past Lives', y: 2023, r: 4.5, d: '2023-09-02', uri: 'https://boxd.it/tS3M', dir: 'Celine Song', g: ['Drama', 'Romance'], rt: 106 },
  { t: 'Akira', y: 1988, r: 4, d: '2022-02-20', uri: 'https://boxd.it/29Xi', dir: 'Katsuhiro Otomo', g: ['Animation', 'Science Fiction'], rt: 124 },
  { t: 'Amélie', y: 2001, r: 4, d: '2021-02-14', uri: 'https://boxd.it/29Bu', dir: 'Jean-Pierre Jeunet', g: ['Comedy', 'Romance'], rt: 122 },
  { t: 'Heat', y: 1995, r: 4.5, d: '2023-06-17', uri: 'https://boxd.it/2a4a', dir: 'Michael Mann', g: ['Crime', 'Action'], rt: 170 },
  { t: 'Everything Everywhere All at Once', y: 2022, r: 4, d: '2022-04-30', uri: 'https://boxd.it/pKNy', dir: 'Daniel Kwan', g: ['Action', 'Comedy'], rt: 139 },
  { t: 'Lost in Translation', y: 2003, r: 4.5, d: '2020-11-09', uri: 'https://boxd.it/29Ci', dir: 'Sofia Coppola', g: ['Drama', 'Romance'], rt: 102 },
  { t: 'Alien', y: 1979, r: 5, d: '2023-10-06', uri: 'https://boxd.it/29Sy', dir: 'Ridley Scott', g: ['Horror', 'Science Fiction'], rt: 117 },
  { t: 'Oldboy', y: 2003, r: 4.5, d: '2022-08-08', uri: 'https://boxd.it/2a4y', dir: 'Park Chan-wook', g: ['Thriller', 'Mystery'], rt: 120 },
  { t: 'Columbus', y: 2017, r: 4, d: '2024-05-01', uri: 'https://boxd.it/dJc2', dir: 'Kogonada', g: ['Drama'], rt: 104 },
];

export function sampleFilms(): Film[] {
  return ROWS.map((r) => {
    const f = emptyFilm(r.t, r.y, r.uri);
    f.rating = r.r;
    f.watchedDate = r.d;
    f.watchCount = 1;
    // Director/genre/runtime are pre-filled so sorting works even with no TMDB key.
    f.director = r.dir;
    f.genres = r.g;
    f.runtime = r.rt;
    return f;
  });
}
